"""Local chess engine helper.

Bridges the Tampermonkey userscript on chess.com to a local Stockfish
instance over WebSocket, using the same wire protocol the script already
spoke to chess-api.com.

Client -> server messages:
    {"fen": "...", "depth": 25, "variants": 5, "maxThinkingTime": 2000}
    {"type": "ping"}

Server -> client messages (one per multipv line):
    {"type": "move", "move": "e2e4", "centipawns": 35, "depth": 25}
    {"type": "move", "move": "e7e5", "mate": 3, "depth": 25}
    {"type": "pong"}
"""

import asyncio
import json
import logging
from pathlib import Path

import chess
import chess.engine
from websockets.asyncio.server import serve

import analyzer

ROOT = Path(__file__).resolve().parent.parent
STOCKFISH = ROOT / "engines" / "stockfish" / "stockfish-windows-x86-64-avxvnni.exe"
LC0 = ROOT / "engines" / "lc0" / "lc0.exe"
LC0_WEIGHTS = ROOT / "engines" / "lc0" / "weights.pb.gz"
OPENINGS_JSON = Path(__file__).resolve().parent / "openings.json"
OPENINGS_INDEX: dict = {}

HOST = "127.0.0.1"
PORT = 8765

SF_OPTIONS = {
    "Threads": 22,
    "Hash": 4096,
}

# Reduced footprint so the ponder engine can run in parallel with the main one
# without starving it. Pondering is best-effort cache fill, not the user's
# critical-path move analysis.
SF_PONDER_OPTIONS = {
    "Threads": 6,
    "Hash": 1024,
}

# Mate-probe Stockfish: small footprint, runs in PARALLEL with the play
# engine when the user picked lc0 to play. lc0 is policy-MCTS and
# occasionally walks past forced mates (esp. in endgame) at the time
# budgets blitz allows; Stockfish is the tactical safety net. This
# instance is separate from the main analyzer Stockfish so it doesn't
# contend with live-analyzer requests during play.
SF_MATE_OPTIONS = {
    "Threads": 4,
    "Hash": 512,
}


def game_phase(board: "chess.Board") -> str:
    """Classify the position as opening / middlegame / endgame.

    Used to pick engine routing and search budgets. The bot leans on lc0 in
    opening (positional strength), runs lc0 + Stockfish mate-probe in
    middlegame (lc0 for plan, SF for tactics), and prefers Stockfish in
    endgame (where deep tactical search converts wins).
    """
    material = 0
    for piece_type in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT):
        material += len(board.pieces(piece_type, chess.WHITE))
        material += len(board.pieces(piece_type, chess.BLACK))
    fullmove = board.fullmove_number
    # Endgame: total non-pawn pieces ≤ 6 (e.g., R+R, Q vs R+B).
    if material <= 6:
        return "endgame"
    # Opening: low fullmove count + most pieces still on the board.
    if fullmove <= 12 and material >= 12:
        return "opening"
    return "middlegame"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("helper")


def info_to_payload(line, board):
    """Convert python-chess analyse() line to chess-api wire format (current-POV cp)."""
    pv = line.get("pv") or []
    if not pv:
        return None
    pov = line["score"].pov(board.turn)
    payload = {"type": "move", "move": pv[0].uci(), "depth": line.get("depth", 0)}
    if pov.is_mate():
        payload["mate"] = pov.mate()
    else:
        payload["centipawns"] = pov.score()
    return payload


def info_to_white_pov_lines(info_lines, multipv_target):
    """Convert python-chess analyse() lines list to analyzer.py format (white-POV cp)."""
    if not isinstance(info_lines, list):
        info_lines = [info_lines]
    out = []
    for line in info_lines:
        pv = line.get("pv") or []
        if not pv:
            continue
        score_white = line["score"].pov(chess.WHITE)
        entry = {
            "pv": [m.uci() for m in pv],
            "depth": line.get("depth", 0),
            "multiPv": line.get("multipv", len(out) + 1),
        }
        if score_white.is_mate():
            entry["mate"] = score_white.mate()
        else:
            entry["cp"] = score_white.score()
        out.append(entry)
    return out


async def analyze_position_for_review(engine, board, depth, multipv, time_ms):
    """Analyze a position and return analyzer-format dict (white-POV)."""
    info = await engine.analyse(
        board,
        chess.engine.Limit(depth=depth, time=time_ms / 1000),
        multipv=multipv,
    )
    lines = info_to_white_pov_lines(info, multipv)
    return {
        "lines": lines,
        "bestMove": lines[0]["pv"][0] if lines and lines[0]["pv"] else None,
    }


def derive_uci_move(prev_fen: str, current_fen: str):
    """Find the legal move from prev_fen that yields current_fen (piece placement)."""
    board = chess.Board(prev_fen)
    target_pp = current_fen.split(" ")[0]
    for move in board.legal_moves:
        board.push(move)
        if board.board_fen() == target_pp:
            uci = move.uci()
            board.pop()
            return uci
        board.pop()
    return None


async def run_analyze_position(ws, engine, engine_name, req):
    """Single-position analysis with type-tagged response (no chess-api ambiguity)."""
    fen = req.get("fen")
    if not fen:
        await ws.send(json.dumps({"type": "analysis_error", "error": "missing fen"}))
        return
    depth = int(req.get("depth", 14))
    multipv = int(req.get("variants") or req.get("multipv") or 5)
    time_ms = int(req.get("maxThinkingTime", 1500))
    try:
        board = chess.Board(fen)
    except ValueError as e:
        await ws.send(json.dumps({"type": "analysis_error", "error": f"bad fen: {e}"}))
        return
    if board.is_game_over():
        if board.is_checkmate():
            losing = board.turn
            lines = [{"pv": [], "mate": -1 if losing == chess.WHITE else 1, "depth": 0, "multiPv": 1}]
        else:
            lines = [{"pv": [], "cp": 0, "depth": 0, "multiPv": 1}]
        win_pct = 100.0 if (board.is_checkmate() and board.turn == chess.BLACK) else (
            0.0 if board.is_checkmate() else 50.0
        )
    else:
        pos = await analyze_position_for_review(engine, board, depth, multipv, time_ms)
        lines = pos["lines"]
        win_pct = analyzer.position_win_percent(pos) if lines else 50.0
    opening = OPENINGS_INDEX.get(fen.split(" ")[0])
    await ws.send(json.dumps({
        "type": "position_analysis",
        "fen": fen,
        "lines": lines,
        "win_percent": win_pct,
        "opening": opening,
        "engine": engine_name,
    }))


async def run_analyze_move(ws, engine, engine_name, req):
    """Analyze a single move (live-mode helper).

    Request fields:
      prev_fen, current_fen   — required
      prev_eval                — optional, cached analysis of prev_fen
      played_uci               — optional, derived from FEN diff if absent
      depth, variants, maxThinkingTime — analysis params
    """
    prev_fen = req.get("prev_fen")
    current_fen = req.get("current_fen")
    if not prev_fen or not current_fen:
        await ws.send(json.dumps({"type": "analysis_error", "error": "missing prev_fen or current_fen"}))
        return

    depth = int(req.get("depth", 14))
    multipv = int(req.get("variants") or req.get("multipv") or 5)
    time_ms = int(req.get("maxThinkingTime", 1500))

    played_uci = req.get("played_uci")
    played_san = req.get("played_san")

    # If JS supplied SAN (read from chess.com's DOM move list) but no UCI,
    # parse the SAN against prev_fen with python-chess to get the UCI.
    if not played_uci and played_san:
        try:
            tmp_board = chess.Board(prev_fen)
            move = tmp_board.parse_san(played_san)
            played_uci = move.uci()
        except (chess.IllegalMoveError, chess.InvalidMoveError, ValueError, AssertionError) as e:
            await ws.send(json.dumps({
                "type": "analysis_error",
                "error": f"could not parse SAN '{played_san}' from prev_fen: {e}",
            }))
            return

    # If JS supplied the UCI move directly, just verify it's legal and let it
    # define the current position. This avoids the brittle FEN-diff path
    # entirely (the cause of the analyzer-stops-after-1-move bug).
    if played_uci:
        try:
            prev_board = chess.Board(prev_fen)
            move = chess.Move.from_uci(played_uci)
            if move not in prev_board.legal_moves:
                # JS may be a ply behind — drop and let the next poll catch up.
                # Include prev_fen and turn in the error so the client side
                # can diagnose the desync direction (ahead vs behind).
                turn = "w" if prev_board.turn == chess.WHITE else "b"
                await ws.send(json.dumps({
                    "type": "analysis_error",
                    "error": f"played_uci {played_uci} not legal from prev_fen (turn={turn}, fen={prev_fen})",
                }))
                return
            san = prev_board.san(move)
            prev_board.push(move)
            computed_fen = prev_board.fen()
            # If JS gave us a current_fen that doesn't match (i.e., game has
            # advanced past this move), trust the computed one — we'll catch
            # later moves on subsequent polls.
            current_fen = computed_fen
            current_board = chess.Board(current_fen)
        except (chess.InvalidMoveError, ValueError, AssertionError) as e:
            await ws.send(json.dumps({"type": "analysis_error", "error": f"bad played_uci: {e}"}))
            return
    else:
        played_uci = derive_uci_move(prev_fen, current_fen)
        if not played_uci:
            await ws.send(json.dumps({"type": "analysis_error", "error": "could not derive move from FEN diff"}))
            return
        prev_board = chess.Board(prev_fen)
        try:
            move = chess.Move.from_uci(played_uci)
            san = prev_board.san(move)
        except (chess.InvalidMoveError, AssertionError, ValueError):
            san = played_uci
        current_board = chess.Board(current_fen)
    if current_board.is_checkmate():
        losing = current_board.turn
        current_pos = {
            "lines": [{
                "pv": [],
                "mate": -1 if losing == chess.WHITE else 1,
                "depth": 0,
                "multiPv": 1,
            }],
            "bestMove": None,
        }
    elif (
        current_board.is_stalemate()
        or current_board.is_insufficient_material()
        or current_board.is_seventyfive_moves()
        or current_board.is_fivefold_repetition()
    ):
        current_pos = {"lines": [{"pv": [], "cp": 0, "depth": 0, "multiPv": 1}], "bestMove": None}
    else:
        current_pos = await analyze_position_for_review(engine, current_board, depth, multipv, time_ms)

    prev_eval = req.get("prev_eval")
    if not prev_eval or not prev_eval.get("lines"):
        if prev_board.is_game_over():
            await ws.send(json.dumps({"type": "analysis_error", "error": "prev position is game over"}))
            return
        prev_eval = await analyze_position_for_review(engine, prev_board, depth, multipv, time_ms)

    is_white_move = prev_board.turn == chess.WHITE
    classification = analyzer.classify_single_move(
        prev_eval, current_pos, played_uci, prev_fen, current_fen,
        is_white_move, OPENINGS_INDEX,
    )

    win_before = analyzer.position_win_percent(prev_eval) if prev_eval.get("lines") else None
    win_after = analyzer.position_win_percent(current_pos) if current_pos.get("lines") else None
    opening = OPENINGS_INDEX.get(current_fen.split(" ")[0])

    await ws.send(json.dumps({
        "type": "move_analysis",
        "uci": played_uci,
        "san": san,
        "current_fen": current_fen,
        "lines": current_pos["lines"],
        "win_percent": win_after,
        "win_percent_before": win_before,
        "classification": classification,
        "opening": opening,
        "engine": engine_name,
    }))
    log.info(f"analyze_move {played_uci} ({san}) -> {classification}")


async def run_analyze_game(ws, engine, engine_name, req):
    """Replay a game from move list, analyze every position, classify moves."""
    moves_uci = req.get("moves") or []
    depth = int(req.get("depth", 18))
    multipv = int(req.get("variants") or req.get("multipv") or 5)
    time_ms = int(req.get("maxThinkingTime", 3000))
    white_elo = req.get("white_elo")
    black_elo = req.get("black_elo")

    board = chess.Board()
    fens = [board.fen()]
    san_moves: list[str] = []
    valid_uci_moves: list[str] = []

    for uci in moves_uci:
        try:
            move = chess.Move.from_uci(uci)
        except chess.InvalidMoveError:
            await ws.send(json.dumps({"type": "analysis_error", "error": f"invalid uci: {uci}"}))
            return
        if move not in board.legal_moves:
            await ws.send(json.dumps({"type": "analysis_error", "error": f"illegal move: {uci}"}))
            return
        san_moves.append(board.san(move))
        valid_uci_moves.append(uci)
        board.push(move)
        fens.append(board.fen())

    total = len(fens)
    log.info(f"analyze_game: replaying {len(valid_uci_moves)} moves, analyzing {total} positions")

    positions: list[dict] = []
    for idx, fen in enumerate(fens):
        analysis_board = chess.Board(fen)
        if analysis_board.is_checkmate():
            # Side-to-move is mated; from white POV, mate value sign indicates winner.
            losing = analysis_board.turn
            pos = {
                "lines": [{
                    "pv": [],
                    "mate": -1 if losing == chess.WHITE else 1,
                    "depth": 0,
                    "multiPv": 1,
                }],
                "bestMove": None,
            }
        elif (
            analysis_board.is_stalemate()
            or analysis_board.is_insufficient_material()
            or analysis_board.is_seventyfive_moves()
            or analysis_board.is_fivefold_repetition()
        ):
            pos = {
                "lines": [{"pv": [], "cp": 0, "depth": 0, "multiPv": 1}],
                "bestMove": None,
            }
        else:
            pos = await analyze_position_for_review(
                engine, analysis_board, depth, multipv, time_ms
            )
        positions.append(pos)
        if idx % 2 == 0 or idx == total - 1:
            await ws.send(json.dumps({
                "type": "analysis_progress",
                "ply": idx,
                "total": total - 1,
            }))

    classified = analyzer.classify_moves(positions, valid_uci_moves, fens, OPENINGS_INDEX)
    accuracy = analyzer.compute_game_accuracy(classified)
    estimated_elo = analyzer.compute_estimated_elo(classified, white_elo, black_elo)

    out_positions = []
    for i, pos in enumerate(classified):
        entry = {
            "index": i,
            "fen": fens[i],
            "lines": pos.get("lines", []),
            "win_percent": (
                analyzer.position_win_percent(pos) if pos.get("lines") else None
            ),
            "moveClassification": pos.get("moveClassification"),
            "opening": pos.get("opening"),
        }
        if i > 0:
            entry["uci"] = valid_uci_moves[i - 1]
            entry["san"] = san_moves[i - 1]
        out_positions.append(entry)

    await ws.send(json.dumps({
        "type": "analysis_complete",
        "engine": engine_name,
        "depth": depth,
        "positions": out_positions,
        "accuracy": accuracy,
        "estimated_elo": estimated_elo,
    }))
    log.info(
        f"analyze_game done: acc W={accuracy['white']:.1f} B={accuracy['black']:.1f} "
        f"elo W={estimated_elo['white']:.0f} B={estimated_elo['black']:.0f}"
    )


async def spawn(name):
    if name == "stockfish":
        _, eng = await chess.engine.popen_uci(str(STOCKFISH))
        await eng.configure(SF_OPTIONS)
        return eng
    if name == "stockfish_ponder":
        _, eng = await chess.engine.popen_uci(str(STOCKFISH))
        await eng.configure(SF_PONDER_OPTIONS)
        return eng
    if name == "stockfish_mate":
        _, eng = await chess.engine.popen_uci(str(STOCKFISH))
        await eng.configure(SF_MATE_OPTIONS)
        return eng
    if name == "lc0":
        _, eng = await chess.engine.popen_uci(
            [str(LC0), f"--weights={LC0_WEIGHTS}", "--backend=cuda-fp16"],
            cwd=str(LC0.parent),
        )
        return eng
    raise ValueError(f"unknown engine: {name}")


async def run_ponder(ws, engine, engine_name, req):
    """Pre-analyze likely user-turn positions during opponent's think time.

    From the current FEN (opponent to move), find their top-K replies via a
    quick MultiPV pass, push each candidate, and analyze the resulting
    user-to-move position. Stream each result so the client can cache it under
    the resulting FEN — when the opponent actually plays one of them, the
    user's analysis is an instant cache hit (zero engine time).

    Runs on a separate engine process (stockfish_ponder) so it never blocks the
    main engine handling the user's critical-path moves.
    """
    fen = req.get("fen")
    if not fen:
        await ws.send(json.dumps({"type": "ponder_done", "reason": "missing fen"}))
        return
    depth = int(req.get("depth", 12))
    multipv = int(req.get("variants") or req.get("multipv") or 5)
    time_ms = int(req.get("maxThinkingTime", 600))
    top_k = max(1, min(int(req.get("ponder_top_k", 3)), 5))

    try:
        board = chess.Board(fen)
    except ValueError:
        await ws.send(json.dumps({"type": "ponder_done", "reason": "bad fen"}))
        return
    if board.is_game_over():
        await ws.send(json.dumps({"type": "ponder_done", "reason": "game over"}))
        return

    # Candidate-finder pass: cheap survey just to learn opp's top-K replies.
    # Per-position passes below carry the real analysis weight.
    finder_depth = max(6, min(depth - 2, 10))
    finder_time = max(0.05, min(time_ms / 2000, 0.30))
    info = await engine.analyse(
        board,
        chess.engine.Limit(depth=finder_depth, time=finder_time),
        multipv=max(top_k, 2),
    )
    if not isinstance(info, list):
        info = [info]

    candidates = []
    for line in info[:top_k]:
        pv = line.get("pv") or []
        if pv:
            candidates.append(pv[0])

    sent = 0
    for move in candidates:
        next_board = board.copy()
        next_board.push(move)
        if next_board.is_game_over():
            continue
        next_fen = next_board.fen()
        next_info = await engine.analyse(
            next_board,
            chess.engine.Limit(depth=depth, time=time_ms / 1000),
            multipv=multipv,
        )
        if not isinstance(next_info, list):
            next_info = [next_info]

        moves_payload = []
        for line in next_info:
            pv = line.get("pv") or []
            if not pv:
                continue
            pov = line["score"].pov(next_board.turn)
            entry = {"move": pv[0].uci(), "depth": line.get("depth", 0)}
            if pov.is_mate():
                entry["mate"] = pov.mate()
            else:
                entry["centipawns"] = pov.score()
            moves_payload.append(entry)

        if not moves_payload:
            continue
        await ws.send(json.dumps({
            "type": "ponder_result",
            "fen": next_fen,
            "after_move": move.uci(),
            "moves": moves_payload,
            "engine": engine_name,
        }))
        sent += 1

    await ws.send(json.dumps({"type": "ponder_done", "sent": sent}))
    log.info(f"ponder fen={fen.split(' ')[0][:24]}… top_k={top_k} sent={sent}")


class LockedWS:
    """Thin proxy that serializes ws.send() across concurrent tasks.

    The websockets library's send() is not safe to call concurrently from
    multiple coroutines — frames can interleave. We process requests as
    background tasks so play and live-analysis run on different engine
    processes in parallel; this lock keeps their JSON responses framed.
    """

    def __init__(self, ws, lock):
        self._ws = ws
        self._lock = lock

    async def send(self, payload):
        async with self._lock:
            await self._ws.send(payload)


async def run_play(ws, engine, engine_name, req, get_engine=None, engine_locks=None):
    """Phase-aware play handler with dual-engine combination.

    Routing:
      Opening (≤ move 12, full material): lc0 alone — strongest positional
        play, no need to spend a Stockfish slot on tactics that aren't there.
      Middlegame: primary engine + Stockfish mate-probe in PARALLEL. Probe
        is short (≤ 1.0s) and only overrides if it finds a forced mate the
        primary missed. The user keeps lc0's strategic style; SF catches
        tactics.
      Endgame (≤ 6 non-pawn pieces): Stockfish takes over as primary if the
        user picked lc0 — Stockfish's deep search converts wins. lc0 stays
        in the rotation as the analysis engine on the other side. Mate
        probe runs deeper (depth 22, up to 2s) to confirm the kill.

    The Stockfish mate-probe runs on a SEPARATE engine process
    (stockfish_mate) so it never contends with the live analyzer's
    Stockfish (which serves move classifications in parallel).
    """
    fen = req.get("fen")
    request_id = req.get("requestId")
    if not fen:
        if request_id is not None:
            try:
                await ws.send(json.dumps({"type": "play_done", "requestId": request_id, "reason": "missing fen"}))
            except Exception:
                pass
        return
    depth = int(req.get("depth", 18))
    multipv = int(req.get("variants") or req.get("multipv") or 5)
    time_ms = int(req.get("maxThinkingTime", 5000))

    try:
        board = chess.Board(fen)
    except ValueError:
        if request_id is not None:
            try:
                await ws.send(json.dumps({"type": "play_done", "requestId": request_id, "reason": "bad fen"}))
            except Exception:
                pass
        return

    phase = game_phase(board)

    # Phase-aware mate probe — FIRE AND FORGET in the background. The bot's
    # critical path is lc0 alone; if the probe finds a mate within the
    # client's timeout window, its message arrives and selectMove picks it.
    # If not, the bot plays lc0's move on time. The previous asyncio.gather
    # version blocked the response until BOTH finished, which made every
    # move take max(lc0_time, probe_time) — when no mate exists the probe
    # uses its full budget, blowing past the client's wsTimeout.
    use_mate_probe = (engine_name == "lc0" and get_engine is not None)

    async def _probe_and_send():
        try:
            sf_mate = await get_engine("stockfish_mate")
        except (ValueError, Exception):
            return
        mate_lock = engine_locks.get("stockfish_mate") if engine_locks else None
        # Tight budgets so the probe can finish (with mate, or give up)
        # within the client's wsTimeout window. Limit(mate=N) tells
        # Stockfish to focus on mate search rather than positional eval.
        if phase == "endgame":
            probe_limit = chess.engine.Limit(mate=12, time=min((time_ms / 1000) * 0.7, 1.8))
        elif phase == "middlegame":
            probe_limit = chess.engine.Limit(mate=8, time=min((time_ms / 1000) * 0.4, 0.8))
        else:  # opening
            probe_limit = chess.engine.Limit(mate=5, time=0.25)
        try:
            if mate_lock is not None:
                async with mate_lock:
                    info = await sf_mate.analyse(board, probe_limit, multipv=1)
            else:
                info = await sf_mate.analyse(board, probe_limit, multipv=1)
            if not info or not info.get("pv"):
                return
            sf_score = info["score"].pov(board.turn)
            if not (sf_score.is_mate() and sf_score.mate() and sf_score.mate() > 0):
                return
            mate_move = info["pv"][0].uci()
            payload = {
                "type": "move",
                "move": mate_move,
                "mate": sf_score.mate(),
                "depth": info.get("depth", 0),
                "engine": f"sf-mate-probe-{phase}",
                "phase": phase,
            }
            if request_id is not None:
                payload["requestId"] = request_id
            await ws.send(json.dumps(payload))
            log.info(
                f"sf-mate-probe ({phase}) found mate-in-{sf_score.mate()}: "
                f"{mate_move} (primary={engine_name})"
            )
        except Exception as e:
            log.warning(f"mate-probe error: {e}")

    if use_mate_probe:
        # Fire-and-forget: don't await. Probe runs in parallel with lc0,
        # writes its mate move to the client only if/when it finds one.
        asyncio.create_task(_probe_and_send())

    # CRITICAL PATH: run lc0 and send its results. This always completes
    # within the engine's time budget, so the bot moves on time regardless
    # of whether the probe finds anything.
    moves: list = []
    try:
        main_info = await engine.analyse(
            board,
            chess.engine.Limit(depth=depth, time=time_ms / 1000),
            multipv=multipv,
        )
        if not isinstance(main_info, list):
            main_info = [main_info]

        for line in main_info:
            payload = info_to_payload(line, board)
            if payload:
                payload["engine"] = engine_name
                payload["phase"] = phase
                if request_id is not None:
                    payload["requestId"] = request_id
                moves.append(payload["move"])
                await ws.send(json.dumps(payload))
        log.info(f"{engine_name} ({phase}) d={depth} mpv={multipv} -> {moves}")
    finally:
        # ALWAYS signal end-of-batch so the client can process immediately
        # instead of waiting on its safety-net timer. Without this the
        # client sat idle for the full thinkTime+grace window after the
        # engine had already returned. Background-tab timer throttling
        # made the wait unbounded — onmessage isn't throttled, so this
        # message lets the client act in real time even when not focused.
        done_payload = {"type": "play_done", "engine": engine_name, "phase": phase, "moves": moves}
        if request_id is not None:
            done_payload["requestId"] = request_id
        try:
            await ws.send(json.dumps(done_payload))
        except Exception:
            pass


async def handle(ws):
    peer = ws.remote_address
    log.info(f"connected {peer}")
    # One engine process per name. Each engine runs requests serially (UCI
    # supports a single in-flight `go` per process), but DIFFERENT engines run
    # in parallel — that's how dual-engine routing buys throughput.
    engines: dict = {}
    engine_locks: dict = {}
    ponder_task: asyncio.Task | None = None
    request_tasks: set[asyncio.Task] = set()
    send_lock = asyncio.Lock()
    locked_ws = LockedWS(ws, send_lock)

    async def get_engine(name):
        if name not in engines:
            log.info(f"spawning {name}")
            engines[name] = await spawn(name)
            engine_locks[name] = asyncio.Lock()
        return engines[name]

    async def _dispatch(req, kind):
        """Run an analysis request to completion under the engine's lock.

        Multiple `_dispatch` tasks can be in flight at once — they only
        contend if they share an engine_name (different engines = parallel).
        For 'play' we also pass get_engine so phase-aware routing can
        opportunistically swap engines (e.g., lc0 → stockfish in endgame)
        and run a parallel mate-probe on stockfish_mate.
        """
        engine_name = req.get("engine", "stockfish")
        try:
            engine = await get_engine(engine_name)
        except ValueError as e:
            log.warning(str(e))
            return
        lock = engine_locks[engine_name]
        async with lock:
            try:
                if kind == "position":
                    await run_analyze_position(locked_ws, engine, engine_name, req)
                elif kind == "move":
                    await run_analyze_move(locked_ws, engine, engine_name, req)
                elif kind == "game":
                    await run_analyze_game(locked_ws, engine, engine_name, req)
                else:  # play
                    await run_play(
                        locked_ws, engine, engine_name, req,
                        get_engine=get_engine, engine_locks=engine_locks,
                    )
            except chess.engine.EngineTerminatedError:
                log.error(f"{engine_name} died during {kind}")
                engines.pop(engine_name, None)
                engine_locks.pop(engine_name, None)
            except Exception as e:
                log.warning(f"{kind} error: {e}")

    async def _ponder_safe(engine, engine_name, req):
        try:
            await run_ponder(locked_ws, engine, engine_name, req)
        except asyncio.CancelledError:
            log.info("ponder cancelled")
            raise
        except chess.engine.EngineTerminatedError:
            log.error(f"{engine_name} died during ponder")
            engines.pop(engine_name, None)
            engine_locks.pop(engine_name, None)
        except Exception as e:
            log.warning(f"ponder error: {e}")

    def _spawn_request(req, kind):
        task = asyncio.create_task(_dispatch(req, kind))
        request_tasks.add(task)
        task.add_done_callback(request_tasks.discard)

    try:
        async for raw in ws:
            try:
                req = json.loads(raw)
            except json.JSONDecodeError:
                continue

            rtype = req.get("type")

            if rtype == "ping":
                await locked_ws.send(json.dumps({"type": "pong"}))
                continue

            if rtype == "warmup":
                # Pre-spawn engine processes so the FIRST real request doesn't
                # eat 2-5s of cold-start (lc0 CUDA init, stockfish 4GB hash
                # alloc). Without this, the very first move of every session
                # times out client-side and is retried — burning ~5s of clock.
                names = req.get("engines") or ["stockfish"]
                spawned = []
                for name in names:
                    try:
                        await get_engine(name)
                        spawned.append(name)
                    except Exception as e:
                        log.warning(f"warmup {name}: {e}")
                await locked_ws.send(json.dumps({"type": "warmup_done", "engines": spawned}))
                continue

            if rtype == "analyze_game":
                _spawn_request(req, "game")
                continue

            if rtype == "analyze_position":
                _spawn_request(req, "position")
                continue

            if rtype == "analyze_move":
                _spawn_request(req, "move")
                continue

            if rtype == "ponder":
                # Cancel any in-flight ponder so we always work on the freshest
                # position.
                if ponder_task and not ponder_task.done():
                    ponder_task.cancel()
                    try:
                        await ponder_task
                    except (asyncio.CancelledError, Exception):
                        pass
                try:
                    ponder_engine = await get_engine("stockfish_ponder")
                except ValueError as e:
                    log.warning(str(e))
                    continue
                ponder_task = asyncio.create_task(
                    _ponder_safe(ponder_engine, "stockfish_ponder", req)
                )
                continue

            # Untyped (or rtype unknown) request with `fen` = legacy play call.
            if req.get("fen"):
                _spawn_request(req, "play")
    finally:
        for t in request_tasks:
            t.cancel()
        for t in list(request_tasks):
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        if ponder_task and not ponder_task.done():
            ponder_task.cancel()
            try:
                await ponder_task
            except (asyncio.CancelledError, Exception):
                pass
        for eng in engines.values():
            try:
                await eng.quit()
            except Exception:
                pass
        log.info(f"disconnected {peer}")


async def main():
    global OPENINGS_INDEX
    if not STOCKFISH.exists():
        raise SystemExit(f"Stockfish not found at {STOCKFISH}")
    OPENINGS_INDEX = analyzer.load_openings_index(OPENINGS_JSON)
    log.info(f"helper listening on ws://{HOST}:{PORT}")
    log.info(
        f"stockfish={STOCKFISH.name} threads={SF_OPTIONS['Threads']} "
        f"hash={SF_OPTIONS['Hash']}MB openings={len(OPENINGS_INDEX)}"
    )
    async with serve(handle, HOST, PORT, ping_interval=30):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("bye")
