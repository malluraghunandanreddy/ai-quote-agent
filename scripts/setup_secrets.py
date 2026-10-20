"""Type the demo's two remaining secrets once, at hidden prompts. They are written only to .env.

    .venv/bin/python scripts/setup_secrets.py

1. Gemini API key           (aistudio.google.com → Get API key)  — or the Claude key if AI_PROVIDER=anthropic
2. Zoho Mail app password   (accounts.zoho.in → Security → App Passwords, logged in as the demo mailbox)

Press Enter at a prompt to keep the current value. Zoho Books credentials are set by
scripts/zoho_oauth_helper.py instead.
"""
from __future__ import annotations

import getpass
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import get_settings  # noqa: E402
from app.envfile import ENV_PATH, update_env  # noqa: E402


def main() -> int:
    s = get_settings()
    updates: dict[str, str] = {}

    gemini = s.ai_provider == "gemini"
    label, env_key, prefix = ("Gemini", "GEMINI_API_KEY", "AIza") if gemini else ("Anthropic", "ANTHROPIC_API_KEY", "sk-ant-")
    key = getpass.getpass(f"{label} API key (hidden){' [already set — Enter to keep]' if s.ai_enabled else ''}: ").strip()
    if key:
        if not key.startswith(prefix):
            print(f"  ⚠ That doesn't look like a {label} key (they usually start with '{prefix}'). Saving it anyway.")
        updates[env_key] = key

    pw = getpass.getpass(f"Zoho Mail app password for {s.imap_user} (hidden)"
                         f"{' [already set — Enter to keep]' if s.imap_password else ''}: ").strip()
    if pw:
        updates["IMAP_PASSWORD"] = pw
        updates["SMTP_PASSWORD"] = pw

    if not updates:
        print("Nothing changed.")
        return 0
    update_env(updates)
    print(f"✓ Saved {', '.join(sorted(updates))} to {ENV_PATH.name} (values not shown).")

    if (input("Run the read-only connection check now? [Y/n]: ").strip().lower() or "y") == "y":
        subprocess.run([sys.executable, str(ROOT / "scripts" / "check_connections.py")])
    print("Restart the dashboard server so it picks up the new settings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
