"""One-off converter: openings.ts (Chesskit) -> openings.json.

Run when Chesskit's openings list changes. Reads the TypeScript source,
extracts each {name, fen} pair, writes a JSON file the helper loads at
startup.
"""

import json
import re
from pathlib import Path


def main():
    src = (
        Path(__file__).resolve().parent.parent
        / "Community built analyzer"
        / "Chesskit-source"
        / "src"
        / "data"
        / "openings.ts"
    )
    out = Path(__file__).resolve().parent / "openings.json"

    text = src.read_text(encoding="utf-8")
    pairs = re.findall(
        r'name:\s*"([^"]+)",\s*fen:\s*"([^"]+)"',
        text,
    )
    data = [{"name": n, "fen": f} for n, f in pairs]
    out.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"wrote {len(data)} openings to {out}")


if __name__ == "__main__":
    main()
