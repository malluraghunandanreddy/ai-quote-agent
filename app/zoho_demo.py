"""Demo customer + items for a live Zoho Books POC — shared by the Setup page and scripts/seed_zoho_demo.py.

Skips anything that already exists (customer by email, item by SKU or name), so it is safe to run twice.
"""
from __future__ import annotations

import json

from .config import DATA_DIR, get_settings
from .connectors.base import ConnectorError
from .connectors.zoho_books import ZohoBooksConnector
from .mapper import norm


async def plan(zoho: ZohoBooksConnector, gst_treatment: str | None = None, place_of_supply: str | None = None,
               hsn: str | None = None) -> tuple[list[dict], list[str]]:
    """Returns (records to create [{path, label, body}], notes about what already exists)."""
    s = get_settings()
    catalog = json.loads((DATA_DIR / "mock_zoho_catalog.json").read_text())
    demo, email = catalog["customers"][0], s.demo_customer_email
    existing = await zoho.find_customer(email)
    current = await zoho.get_items()
    todo, notes = [], []
    if existing:
        notes.append(f"Customer already exists: {existing.contact_name} ({email})")
    else:
        body = {"contact_name": demo["contact_name"], "company_name": demo["contact_name"], "contact_type": "customer",
                "contact_persons": [{"first_name": "Demo", "last_name": "Buyer", "email": email, "is_primary_contact": True}]}
        if gst_treatment:
            body["gst_treatment"] = gst_treatment
        if place_of_supply:
            body["place_of_contact"] = place_of_supply
        todo.append({"path": "/contacts", "label": f"Customer: {demo['contact_name']} <{email}>", "body": body})
    have = {norm(i.sku) for i in current if i.sku} | {norm(i.name) for i in current}
    for item in catalog["items"]:
        if not item.get("seed", True):
            continue
        if norm(item.get("sku")) in have or norm(item["name"]) in have:
            notes.append(f"Item already exists: {item['name']}")
            continue
        body = {"name": item["name"], "sku": item.get("sku"), "rate": item["rate"], "unit": item.get("unit"),
                "description": item.get("description") or "", "item_type": "sales", "product_type": "goods"}
        if hsn:
            body["hsn_or_sac"] = hsn
        price = f"₹{item['rate']:,.0f}/{item.get('unit')}" if item["rate"] else "no price (shows the price-missing flag)"
        todo.append({"path": "/items", "label": f"Item: {item['name']} — SKU {item.get('sku')}, {price}", "body": body})
    return todo, notes


async def apply(zoho: ZohoBooksConnector, todo: list[dict]) -> list[dict]:
    results = []
    for rec in todo:
        try:
            await zoho.request("POST", rec["path"], json_body=rec["body"])
            results.append({"label": rec["label"], "ok": True, "detail": "created"})
        except ConnectorError as exc:
            results.append({"label": rec["label"], "ok": False, "detail": str(exc)})
    zoho._items = None  # refresh the item cache
    return results
