"""Offline demo connector backed by data/mock_zoho_catalog.json (customers + items modelled on the sample RFQ)."""
from __future__ import annotations

import json
import uuid

from ..config import DATA_DIR
from ..mapper import norm
from ..schemas import CatalogItem, CustomerMatch, DraftQuote, QuoteResult
from .base import Connector

CATALOG = DATA_DIR / "mock_zoho_catalog.json"


class MockConnector(Connector):
    key = "mock"
    name = "Demo catalogue (mock)"
    quote_label = "quotation"
    is_mock = True

    def __init__(self) -> None:
        data = json.loads(CATALOG.read_text())
        self.customers = data["customers"]
        self.items = [CatalogItem(**i) for i in data["items"]]
        self.created: list[tuple[str, str, QuoteResult]] = []

    def readiness(self) -> tuple[bool, str, str]:
        from ..config import get_settings
        from . import CONNECTORS
        lock = get_settings().lock_erp_connector
        fix = (f"Connect {CONNECTORS[lock][2]} in Setup, then switch off demo data" if lock in CONNECTORS
               else "Choose your accounting system in Setup for real quotations")
        return False, f"Demo data only: {len(self.customers)} customers, {len(self.items)} items", fix

    async def check(self) -> str:
        return f"Demo catalogue: {len(self.customers)} customers, {len(self.items)} items"

    async def find_customer(self, *emails: str | None, name: str | None = None) -> CustomerMatch | None:
        wanted = {e.lower() for e in emails if e}
        for method, hits in (("email", [c for c in self.customers if c["email"].lower() in wanted]),
                             ("name", [c for c in self.customers if name and norm(c["contact_name"]) == norm(name)])):
            if hits:
                c = hits[0]
                return CustomerMatch(contact_id=c["contact_id"], contact_name=c["contact_name"], email=c["email"], method=method)
        return None

    async def get_items(self) -> list[CatalogItem]:
        return self.items

    async def create_draft_quote(self, quote: DraftQuote) -> QuoteResult:
        result = QuoteResult(
            quote_id=f"mock-{uuid.uuid4().hex[:10]}",
            quote_number=f"QT-MOCK-{len(self.created) + 1:05d}",
            status="draft",
            total=round(sum(l.quantity * l.rate * (1 - (l.discount_percent or 0) / 100) for l in quote.lines), 2),
            currency="INR",
        )
        self.created.append((quote.customer_id, quote.reference, result))
        return result

    async def find_existing_quote(self, customer_id: str, reference: str) -> QuoteResult | None:
        return next((r for c, ref, r in self.created if c == customer_id and ref == reference), None)
