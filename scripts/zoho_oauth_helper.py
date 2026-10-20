"""One-time Zoho Books OAuth setup: grant code -> refresh token -> organization ID.

1. Open https://api-console.zoho.in (use your data centre's domain) -> Add Client -> Self Client.
2. Copy the Client ID and Client Secret.
3. Self Client -> "Generate Code" tab, scope (the two CREATE scopes let scripts/seed_zoho_demo.py add
   the demo customer and items for you):
       ZohoBooks.estimates.CREATE,ZohoBooks.estimates.READ,ZohoBooks.contacts.CREATE,ZohoBooks.contacts.READ,ZohoBooks.settings.CREATE,ZohoBooks.settings.READ
   duration 10 minutes -> Create -> copy the code.
4. Run:  .venv/bin/python scripts/zoho_oauth_helper.py
   Secrets are typed at hidden prompts and, if you agree, written only to the local .env file.
"""
from __future__ import annotations

import getpass
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.envfile import ENV_PATH, update_env  # noqa: E402


def main() -> int:
    dc = input("Zoho data centre (com, in, eu, com.au, jp, ca, sa) [in]: ").strip() or "in"
    client_id = input("Client ID: ").strip()
    client_secret = getpass.getpass("Client Secret (hidden): ").strip()
    code = getpass.getpass("Grant code from 'Generate Code' (hidden): ").strip()

    r = httpx.post(f"https://accounts.zoho.{dc}/oauth/v2/token", timeout=20, params={
        "code": code, "client_id": client_id, "client_secret": client_secret, "grant_type": "authorization_code",
    })
    data = r.json()
    if "refresh_token" not in data:
        print(f"\nToken exchange failed: {data.get('error', data)}")
        print("Grant codes expire after the chosen duration and work once — generate a fresh one and retry.")
        return 1
    print("\n✓ Refresh token obtained.")

    orgs = httpx.get(f"https://www.zohoapis.{dc}/books/v3/organizations", timeout=20,
                     headers={"Authorization": f"Zoho-oauthtoken {data['access_token']}"}).json().get("organizations", [])
    if not orgs:
        print("No Zoho Books organizations visible to this token — check the scopes and that Books is set up.")
        return 1
    for i, o in enumerate(orgs, 1):
        print(f"  {i}. {o['name']}  (organization_id {o['organization_id']}, currency {o.get('currency_code')})")
    choice = input(f"Which organization? [1-{len(orgs)}, default 1]: ").strip() or "1"
    org = orgs[int(choice) - 1]

    values = {
        "ERP_CONNECTOR": "zoho_books", "ZOHO_DC": dc, "ZOHO_CLIENT_ID": client_id, "ZOHO_CLIENT_SECRET": client_secret,
        "ZOHO_REFRESH_TOKEN": data["refresh_token"], "ZOHO_ORGANIZATION_ID": str(org["organization_id"]),
    }
    if (input(f"Write these to {ENV_PATH.name} now? [Y/n]: ").strip().lower() or "y") == "y":
        update_env(values)
        print(f"✓ Saved to {ENV_PATH}. Restart the server, then run scripts/check_connections.py")
    else:
        print("Not saved. Set ERP_CONNECTOR=zoho_books, ZOHO_DC, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and "
              f"ZOHO_ORGANIZATION_ID={org['organization_id']} in .env yourself.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
