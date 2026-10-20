"""Update KEY=value lines in the local .env without touching anything else in it."""
from __future__ import annotations

from .config import BASE_DIR

ENV_PATH = BASE_DIR / ".env"


def update_env(values: dict[str, str]) -> None:
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    seen = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in values:
            lines[i] = f"{key}={values[key]}"
            seen.add(key)
    lines += [f"{k}={v}" for k, v in values.items() if k not in seen]
    ENV_PATH.write_text("\n".join(lines) + "\n")
