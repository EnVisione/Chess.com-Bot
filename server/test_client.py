"""Smoke test for the local helper.

Tests three flows:
  1. ping/pong
  2. legacy single-position analyze (used by the bot for move picking)
  3. analyze_game (full-game classification + accuracy + estimated Elo)
"""

import asyncio
import json
import sys

from websockets.asyncio.client import connect

URL = "ws://127.0.0.1:8765"
START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# Scholar's mate: 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#
SCHOLARS_MATE = [
    "e2e4", "e7e5",
    "f1c4", "b8c6",
    "d1h5", "g8f6",
    "h5f7",
]


async def request_position(ws, fen, *, engine="stockfish", depth=15, multipv=5, time_ms=2000):
    await ws.send(json.dumps({
        "fen": fen,
        "depth": depth,
        "variants": multipv,
        "maxThinkingTime": time_ms,
        "engine": engine,
    }))
    moves = []
    for _ in range(multipv):
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=time_ms / 1000 + 30))
            moves.append(msg)
        except asyncio.TimeoutError:
            break
    return moves


async def request_game(ws, moves, *, engine="stockfish", depth=12, multipv=5, time_ms=1500):
    await ws.send(json.dumps({
        "type": "analyze_game",
        "moves": moves,
        "engine": engine,
        "depth": depth,
        "variants": multipv,
        "maxThinkingTime": time_ms,
    }))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=120))
        if msg["type"] == "analysis_progress":
            print(f"  ...{msg['ply']}/{msg['total']}")
        elif msg["type"] == "analysis_complete":
            return msg
        elif msg["type"] == "analysis_error":
            raise SystemExit(f"server error: {msg['error']}")


async def main():
    for _ in range(10):
        try:
            ws = await connect(URL)
            break
        except (ConnectionRefusedError, OSError):
            await asyncio.sleep(0.5)
    else:
        raise SystemExit("could not connect to helper after 5s")

    async with ws:
        await ws.send(json.dumps({"type": "ping"}))
        pong = json.loads(await ws.recv())
        assert pong == {"type": "pong"}, f"bad pong: {pong}"
        print("ping/pong: ok\n")

        print("--- legacy analyze (startpos, depth 15, mpv 5) ---")
        legacy = await request_position(ws, START_FEN)
        for m in legacy:
            print(" ", m)

        print("\n--- analyze_game (Scholar's mate, depth 12, mpv 5) ---")
        result = await request_game(ws, SCHOLARS_MATE)

        print("\nclassifications per ply:")
        for pos in result["positions"]:
            tag = pos.get("moveClassification") or "(start)"
            san = pos.get("san") or "—"
            wp = pos.get("win_percent")
            wp_s = f"{wp:5.1f}%" if wp is not None else "  N/A"
            book = f" [book: {pos['opening']}]" if pos.get("opening") else ""
            print(f"  ply {pos['index']:>2}  {san:>5}  win={wp_s}  -> {tag}{book}")

        print("\naccuracy:")
        print(f"  white: {result['accuracy']['white']:.1f}%")
        print(f"  black: {result['accuracy']['black']:.1f}%")

        if result["estimated_elo"]:
            elo = result["estimated_elo"]
            print("\nestimated elo:")
            print(f"  white: {elo['white']:.0f}  (acpl {elo['white_acpl']:.1f})")
            print(f"  black: {elo['black']:.0f}  (acpl {elo['black_acpl']:.1f})")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
