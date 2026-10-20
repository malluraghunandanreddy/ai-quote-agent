"""Load the demo customer and catalogue items into your Zoho Books organisation.
(The same is available on the dashboard: Setup → Zoho Books → Demo customer & items.)

    .venv/bin/python scripts/seed_zoho_demo.py           # preview: shows what would be created
    .venv/bin/python scripts/seed_zoho_demo.py --apply   # create them

Needs the ZohoBooks.contacts.CREATE and ZohoBooks.settings.CREATE scopes (see scripts/zoho_oauth_helper.py).
GST-registered organisations: if Zoho rejects records, re-run with e.g.
    --gst-treatment business_none --place-of-supply AP --hsn 8536
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import zoho_demo  # noqa: E402
from app.connectors import ConnectorError  # noqa: E402
from app.connectors.zoho_books import ZohoBooksConnector  # noqa: E402


async def main(args: argparse.Namespace) -> int:
    zoho = ZohoBooksConnector()
    if not zoho.readiness()[0]:
        print("Zoho credentials are missing — connect Zoho Books in Setup (or run scripts/zoho_oauth_helper.py).")
        return 1
    try:
        todo, notes = await zoho_demo.plan(zoho, args.gst_treatment, args.place_of_supply, args.hsn)
    except ConnectorError as exc:
        print(f"✗ Could not read from Zoho Books: {exc}")
        return 1
    for n in notes:
        print(f"• {n} — skipped")
    if not todo:
        print("Nothing to create — Zoho Books already has the demo data.")
        return 0
    print(f"\n{'Creating' if args.apply else 'Would create'}:")
    for rec in todo:
        print(f"  + {rec['label']}")
    if not args.apply:
        print("\nPreview only. Re-run with --apply to create these in Zoho Books.")
        return 0
    results = await zoho_demo.apply(zoho, todo)
    for r in results:
        print(f"  {'✓' if r['ok'] else '✗'} {r['label']}" + ("" if r["ok"] else f"\n      {r['detail']}"))
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually create the records (default: preview)")
    parser.add_argument("--gst-treatment", help="e.g. business_gst, business_none, consumer, overseas")
    parser.add_argument("--place-of-supply", help="two-letter state code, e.g. AP, TS, KA")
    parser.add_argument("--hsn", help="HSN code applied to every demo item, e.g. 8536")
    sys.exit(asyncio.run(main(parser.parse_args())))
