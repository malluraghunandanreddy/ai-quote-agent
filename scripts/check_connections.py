"""Pre-demo check: which live credentials are configured, and does each connection work?

    .venv/bin/python scripts/check_connections.py

Read/login only — creates no estimates and sends no email.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import readiness  # noqa: E402

MARK = {True: "✅", False: "❌", None: "⏭ "}


async def main() -> int:
    print("Configuration")
    for c in readiness.config_checks():
        print(f"  {MARK[c['ok']]} {c['label']:<34} {c['detail']}")
        if not c["ok"]:
            print(f"       → {c['fix']}")
    print("\nLive connections")
    results = await readiness.live_checks()
    for r in results:
        print(f"  {MARK[r['ok']]} {r['label']:<34} {r['detail']}")
    return 1 if any(r["ok"] is False for r in results) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
