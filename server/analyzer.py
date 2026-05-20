"""Chess.com-style move classification, accuracy, and rating estimation.

All formulas are ported from Chesskit (https://github.com/GuillaumeSD/Chesskit),
which itself sources from Lichess's open-source analysis pipeline:
  - Win-percentage curve: lichess-org/lila WinPercent.scala
  - Accuracy formula:     lichess-org/lila AccuracyPercent.scala
  - Estimated Elo:        Lichess forum thread on ACPL-to-Elo mapping

Classification names mirror Chesskit/chess.com:
    splendid    = Brilliant (!!)   — sacrifice that's also winning
    perfect     = Great (!)        — only good move / saved a losing position
    best        = Best (★)         — engine's #1
    excellent   = Excellent (✓)    — within 2% win-rate of best
    okay        = Good (•)         — within 5%
    opening     = Book (📖)         — known opening position
    forced      = Forced (⮕)       — only one legal/sensible move
    inaccuracy  = Inaccuracy (?!)  — 5–10% drop
    mistake     = Mistake (?)      — 10–20% drop
    blunder     = Blunder (??)     — 20%+ drop
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Optional

import chess


# ============================================================================
# Math helpers
# ============================================================================


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _harmonic_mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return len(values) / sum(1 / v for v in values)


def _stddev(values: list[float]) -> float:
    if not values:
        return 0.0
    n = len(values)
    mean = sum(values) / n
    return math.sqrt(sum((x - mean) ** 2 for x in values) / n)


def _weighted_mean(values: list[float], weights: list[float]) -> float:
    if len(values) > len(weights):
        raise ValueError("weights array too short")
    weighted_sum = sum(v * w for v, w in zip(values, weights))
    weight_sum = sum(weights[: len(values)])
    return weighted_sum / weight_sum if weight_sum else 0.0


# ============================================================================
# Win-percentage curve (Lichess formula)
# ============================================================================


def cp_to_win_percent(cp: float) -> float:
    """Centipawn eval -> win percentage (0-100), from White's perspective.

    Source: lila WinPercent.scala (MULTIPLIER -0.00368208, lila PR #11148).
    """
    cp_clamped = _clamp(cp, -1000, 1000)
    win_chance = 2 / (1 + math.exp(-0.00368208 * cp_clamped)) - 1
    return 50 + 50 * win_chance


def line_win_percent(line: dict) -> float:
    if line.get("mate") is not None:
        return 100.0 if line["mate"] > 0 else 0.0
    if line.get("cp") is not None:
        return cp_to_win_percent(line["cp"])
    raise ValueError("line has no cp or mate")


def position_win_percent(position: dict) -> float:
    return line_win_percent(position["lines"][0])


# ============================================================================
# Per-move accuracy (Lichess formula)
# ============================================================================


def move_accuracy(win_before: float, win_after: float, is_white_move: bool) -> float:
    """Accuracy for a single move (0-100), Lichess formula."""
    if is_white_move:
        win_diff = max(0.0, win_before - win_after)
    else:
        win_diff = max(0.0, win_after - win_before)
    raw = (
        103.1668100711649 * math.exp(-0.04354415386753951 * win_diff)
        - 3.166924740191411
    )
    return _clamp(raw + 1, 0.0, 100.0)


# ============================================================================
# Game accuracy (per side)
# ============================================================================


def _get_accuracy_weights(win_pcts: list[float]) -> list[float]:
    """Position-complexity weights = std-dev of win% in a sliding window."""
    window_size = int(_clamp(math.ceil(len(win_pcts) / 10), 2, 8))
    half = round(window_size / 2)
    weights: list[float] = []
    for i in range(1, len(win_pcts)):
        start = i - half
        end = i + half
        if start < 0:
            window = win_pcts[:window_size]
        elif end > len(win_pcts):
            window = win_pcts[-window_size:]
        else:
            window = win_pcts[start:end]
        weights.append(_clamp(_stddev(window), 0.5, 12))
    return weights


def _player_accuracy(
    moves_acc: list[float], weights: list[float], white: bool
) -> float:
    remainder = 0 if white else 1
    player_acc = [a for j, a in enumerate(moves_acc) if j % 2 == remainder]
    player_w = [w for j, w in enumerate(weights) if j % 2 == remainder]
    if not player_acc:
        return 0.0
    wm = _weighted_mean(player_acc, player_w)
    hm = _harmonic_mean([max(a, 10) for a in player_acc])
    return (wm + hm) / 2


def compute_game_accuracy(positions: list[dict]) -> dict:
    """Returns {'white': float, 'black': float}, both 0-100."""
    if len(positions) < 2:
        return {"white": 0.0, "black": 0.0}
    win_pcts = [position_win_percent(p) for p in positions]
    weights = _get_accuracy_weights(win_pcts)
    moves_acc: list[float] = []
    for i in range(1, len(win_pcts)):
        is_white_move = (i % 2 == 1)
        moves_acc.append(
            move_accuracy(win_pcts[i - 1], win_pcts[i], is_white_move)
        )
    return {
        "white": _player_accuracy(moves_acc, weights, white=True),
        "black": _player_accuracy(moves_acc, weights, white=False),
    }


# ============================================================================
# Estimated Elo (per side, from average centipawn loss)
# ============================================================================


def _position_cp(position: dict) -> float:
    line = position["lines"][0]
    if line.get("cp") is not None:
        return _clamp(line["cp"], -1000, 1000)
    if line.get("mate") is not None:
        return 1000.0 if line["mate"] > 0 else -1000.0
    raise ValueError("no cp or mate")


def _avg_cpl_per_player(positions: list[dict]) -> dict:
    if len(positions) < 2:
        return {"white": 0.0, "black": 0.0}
    prev_cp = _position_cp(positions[0])
    white_cpl = 0.0
    black_cpl = 0.0
    for index, pos in enumerate(positions[1:]):
        cp = _position_cp(pos)
        if index % 2 == 0:
            if cp <= prev_cp:
                white_cpl += min(prev_cp - cp, 1000)
        else:
            if cp >= prev_cp:
                black_cpl += min(cp - prev_cp, 1000)
        prev_cp = cp
    n = len(positions) - 1
    white_count = math.ceil(n / 2)
    black_count = math.floor(n / 2)
    return {
        "white": white_cpl / white_count if white_count else 0.0,
        "black": black_cpl / black_count if black_count else 0.0,
    }


def _elo_from_avg_cpl(avg_cpl: float) -> float:
    return 3100 * math.exp(-0.01 * avg_cpl)


def _avg_cpl_from_elo(elo: float) -> float:
    return -100 * math.log(min(elo, 3100) / 3100)


def _elo_from_rating_and_cpl(game_cpl: float, rating: Optional[float]) -> float:
    elo_from_cpl = _elo_from_avg_cpl(game_cpl)
    if not rating:
        return elo_from_cpl
    expected = _avg_cpl_from_elo(rating)
    diff = game_cpl - expected
    if diff == 0:
        return elo_from_cpl
    if diff > 0:
        return rating * math.exp(-0.005 * diff)
    return rating / math.exp(-0.005 * -diff)


def compute_estimated_elo(
    positions: list[dict],
    white_elo: Optional[float] = None,
    black_elo: Optional[float] = None,
) -> Optional[dict]:
    if len(positions) < 2:
        return None
    cpl = _avg_cpl_per_player(positions)
    return {
        "white": _elo_from_rating_and_cpl(cpl["white"], white_elo or black_elo),
        "black": _elo_from_rating_and_cpl(cpl["black"], black_elo or white_elo),
        "white_acpl": cpl["white"],
        "black_acpl": cpl["black"],
    }


# ============================================================================
# Sacrifice / recapture detection (for Brilliant/Great classification)
# ============================================================================


_PIECE_VALUES = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
}


def _material_diff(board: chess.Board) -> int:
    """White material minus black material."""
    score = 0
    for piece_type, value in _PIECE_VALUES.items():
        score += len(board.pieces(piece_type, chess.WHITE)) * value
        score -= len(board.pieces(piece_type, chess.BLACK)) * value
    return score


def is_simple_piece_recapture(fen: str, uci_pair: tuple[str, str]) -> bool:
    """Was move 2 a recapture of the piece move 1 captured on the same square?"""
    board = chess.Board(fen)
    try:
        m1 = chess.Move.from_uci(uci_pair[0])
        m2 = chess.Move.from_uci(uci_pair[1])
    except chess.InvalidMoveError:
        return False
    if m1.to_square != m2.to_square:
        return False
    if m1 not in board.legal_moves:
        return False
    board.push(m1)
    return board.piece_at(m1.to_square) is not None


def is_piece_sacrifice(
    fen: str, played_move: str, best_line_pv: list[str]
) -> bool:
    """Did the player give up material on this move + best continuation?"""
    if not best_line_pv:
        return False
    board = chess.Board(fen)
    white_to_play = board.turn == chess.WHITE
    starting_diff = _material_diff(board)

    moves = [played_move] + list(best_line_pv)
    if len(moves) % 2 == 1:
        moves = moves[:-1]

    captured: dict[chess.Color, list[int]] = {chess.WHITE: [], chess.BLACK: []}
    non_capturing_remaining = 1

    for uci in moves:
        try:
            move = chess.Move.from_uci(uci)
        except chess.InvalidMoveError:
            return False
        if move not in board.legal_moves:
            return False

        moving_color = board.turn
        captured_pt: Optional[int] = None
        if board.is_capture(move):
            if board.is_en_passant(move):
                captured_pt = chess.PAWN
            else:
                target = board.piece_at(move.to_square)
                captured_pt = target.piece_type if target else None

        board.push(move)

        if captured_pt is not None:
            captured[moving_color].append(captured_pt)
            non_capturing_remaining = 1
        else:
            non_capturing_remaining -= 1
            if non_capturing_remaining < 0:
                break

    w_caps = list(captured[chess.WHITE])
    b_caps = list(captured[chess.BLACK])
    for p in list(w_caps):
        if p in b_caps:
            w_caps.remove(p)
            b_caps.remove(p)

    all_remaining = w_caps + b_caps
    if (
        abs(len(w_caps) - len(b_caps)) <= 1
        and all(p == chess.PAWN for p in all_remaining)
    ):
        return False

    ending_diff = _material_diff(board)
    diff_change = ending_diff - starting_diff
    diff_player_relative = diff_change if white_to_play else -diff_change
    return diff_player_relative < 0


# ============================================================================
# Move classification
# ============================================================================


def _basic_classification(
    win_before: float, win_after: float, is_white_move: bool
) -> str:
    diff = (win_after - win_before) * (1 if is_white_move else -1)
    if diff < -20:
        return "blunder"
    if diff < -10:
        return "mistake"
    if diff < -5:
        return "inaccuracy"
    if diff < -2:
        return "okay"
    return "excellent"


def _is_losing_or_alt_winning(
    win_after: float, alt_win: float, is_white_move: bool
) -> bool:
    is_losing = win_after < 50 if is_white_move else win_after > 50
    alt_winning = alt_win > 97 if is_white_move else alt_win < 3
    return is_losing or alt_winning


def _is_splendid(
    win_before: float,
    win_after: float,
    is_white_move: bool,
    played_move: str,
    best_line_pv: list[str],
    fen: str,
    alt_win: Optional[float],
) -> bool:
    if alt_win is None:
        return False
    diff = (win_after - win_before) * (1 if is_white_move else -1)
    if diff < -2:
        return False
    if not is_piece_sacrifice(fen, played_move, best_line_pv):
        return False
    if _is_losing_or_alt_winning(win_after, alt_win, is_white_move):
        return False
    return True


def _is_perfect(
    win_before: float,
    win_after: float,
    is_white_move: bool,
    alt_win: Optional[float],
    fen_two_ago: Optional[str],
    uci_pair: Optional[tuple[str, str]],
) -> bool:
    if alt_win is None:
        return False
    diff = (win_after - win_before) * (1 if is_white_move else -1)
    if diff < -2:
        return False
    if fen_two_ago and uci_pair and is_simple_piece_recapture(fen_two_ago, uci_pair):
        return False
    if _is_losing_or_alt_winning(win_after, alt_win, is_white_move):
        return False
    has_changed_outcome = diff > 10 and (
        (win_before < 50 < win_after) or (win_before > 50 > win_after)
    )
    is_only_good = (win_after - alt_win) * (1 if is_white_move else -1) > 10
    return has_changed_outcome or is_only_good


def classify_moves(
    positions: list[dict],
    uci_moves: list[str],
    fens: list[str],
    openings_index: Optional[dict] = None,
) -> list[dict]:
    """Annotate each position with moveClassification + opening.

    Args:
        positions: list of {lines: [{pv, cp/mate, depth, multiPv}], ...} per ply
        uci_moves: list of UCI move strings; uci_moves[i] gets you from
                   positions[i] to positions[i+1]
        fens:      list of FEN strings; fens[i] is the FEN at positions[i]
        openings_index: optional {piece-placement-fen: opening-name}
    """
    if openings_index is None:
        openings_index = {}

    win_pcts = [position_win_percent(p) for p in positions]
    current_opening: Optional[str] = None
    classified: list[dict] = []

    for index in range(len(positions)):
        position = dict(positions[index])

        if index == 0:
            classified.append(position)
            continue

        # Opening (Book)
        fen_key = fens[index].split(" ")[0]
        if fen_key in openings_index:
            current_opening = openings_index[fen_key]
            position["opening"] = current_opening
            position["moveClassification"] = "opening"
            classified.append(position)
            continue

        prev = positions[index - 1]

        # Forced (only legal move at prev)
        if len(prev.get("lines", [])) <= 1:
            position["opening"] = current_opening
            position["moveClassification"] = "forced"
            classified.append(position)
            continue

        played_move = uci_moves[index - 1]
        prev_win = win_pcts[index - 1]
        cur_win = win_pcts[index]
        is_white_move = (index % 2 == 1)

        # Alternative line at the previous position (best non-played-move)
        alt_lines = [l for l in prev["lines"] if l["pv"] and l["pv"][0] != played_move]
        alt_win = line_win_percent(alt_lines[0]) if alt_lines else None

        best_pv = position["lines"][0]["pv"] if position.get("lines") else []

        # Splendid (Brilliant)
        if _is_splendid(
            prev_win,
            cur_win,
            is_white_move,
            played_move,
            best_pv,
            fens[index - 1],
            alt_win,
        ):
            position["opening"] = current_opening
            position["moveClassification"] = "splendid"
            classified.append(position)
            continue

        # Perfect (Great)
        fen_two_ago = fens[index - 2] if index > 1 else None
        uci_pair = (
            (uci_moves[index - 2], uci_moves[index - 1]) if index > 1 else None
        )
        if _is_perfect(prev_win, cur_win, is_white_move, alt_win, fen_two_ago, uci_pair):
            position["opening"] = current_opening
            position["moveClassification"] = "perfect"
            classified.append(position)
            continue

        # Best
        prev_best = prev["lines"][0]["pv"][0] if prev.get("lines") else None
        if played_move == prev_best:
            position["opening"] = current_opening
            position["moveClassification"] = "best"
            classified.append(position)
            continue

        # Basic classification (excellent/okay/inaccuracy/mistake/blunder)
        position["opening"] = current_opening
        position["moveClassification"] = _basic_classification(
            prev_win, cur_win, is_white_move
        )
        classified.append(position)

    return classified


# ============================================================================
# Openings index loading
# ============================================================================


def classify_single_move(
    prev_position: dict,
    current_position: dict,
    played_uci: str,
    prev_fen: str,
    current_fen: str,
    is_white_move: bool,
    openings_index: Optional[dict] = None,
    fen_two_ago: Optional[str] = None,
    uci_pair: Optional[tuple] = None,
) -> str:
    """Classify a single move in isolation. Used by the live-mode analyzer."""
    if openings_index is None:
        openings_index = {}

    fen_key = current_fen.split(" ")[0]
    if fen_key in openings_index:
        return "opening"

    if len(prev_position.get("lines", [])) <= 1:
        return "forced"

    if not current_position.get("lines"):
        # Game over after move (mate/stalemate) — fall back to win%-based classification
        win_before = position_win_percent(prev_position)
        win_after = 100 if is_white_move else 0  # we mated = good for us
        if not _is_losing_or_alt_winning(win_after, 0, is_white_move):
            return "best"
        return _basic_classification(win_before, win_after, is_white_move)

    win_before = position_win_percent(prev_position)
    win_after = position_win_percent(current_position)
    alt_lines = [l for l in prev_position["lines"] if l.get("pv") and l["pv"][0] != played_uci]
    alt_win = line_win_percent(alt_lines[0]) if alt_lines else None
    best_pv = current_position["lines"][0].get("pv", [])

    if _is_splendid(win_before, win_after, is_white_move, played_uci, best_pv, prev_fen, alt_win):
        return "splendid"

    if _is_perfect(win_before, win_after, is_white_move, alt_win, fen_two_ago, uci_pair):
        return "perfect"

    prev_best = prev_position["lines"][0]["pv"][0] if prev_position["lines"][0].get("pv") else None
    if played_uci == prev_best:
        return "best"

    return _basic_classification(win_before, win_after, is_white_move)


def load_openings_index(path: Path) -> dict:
    """Load openings.json and return {piece-placement-fen: opening-name}."""
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {entry["fen"]: entry["name"] for entry in raw}
