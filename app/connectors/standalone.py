"""Standalone connector — for freelancers and small businesses with no accounting software.

Everything lives in STANDALONE_DIR (default data/standalone):
  price_list.xlsx | .xls | .csv   the product master the business maintains (code, name, unit, price, description)
  customers.csv                   customer list, grown automatically from enquiry senders
  quotes/<number>.pdf / .xlsx     each draft quotation, also attached to the Sales notification email
  quotes/<number>.json            machine-readable copy (duplicate guard, audit)
  quotes/quote_lines.csv          every quoted line, ready to import into any accounting tool later
"""
from __future__ import annotations

import csv
import json
from datetime import date

from .. import documents
from ..config import get_settings
from ..excel_parser import _map_header, clean_text, load_sheets, to_number
from ..mapper import norm
from ..schemas import CatalogItem, CustomerMatch, DraftQuote, QuoteResult
from .base import Connector, ConnectorError

PRICE_LIST_NAMES = ("price_list.xlsx", "price_list.xls", "price_list.csv")
CUSTOMER_FIELDS = ["customer_id", "name", "email", "phone", "created"]
LINE_FIELDS = ["quote_number", "date", "customer_id", "customer_name", "reference", "line_no", "item_code",
               "item_name", "quantity", "unit", "rate", "amount"]


class StandaloneConnector(Connector):
    key = "standalone"
    name = "No accounting software"
    quote_label = "quotation"

    def __init__(self) -> None:
        self.s = get_settings()
        self.dir = self.s.standalone_dir
        self.quotes_dir = self.dir / "quotes"
        self.customers_path = self.dir / "customers.csv"
        self._items: list[CatalogItem] | None = None
        self._items_mtime = 0.0

    @property
    def price_list(self):
        return next((self.dir / n for n in PRICE_LIST_NAMES if (self.dir / n).exists()), None)

    # --- config ---------------------------------------------------------------------------
    def readiness(self) -> tuple[bool, str, str]:
        if not self.price_list:
            return False, f"No price list in {self.dir.name}/", "Add price_list.xlsx (columns: Item code, Item name, Unit, Price, Description)"
        return True, f"Price list {self.price_list.name}; quotes saved to {self.dir.name}/quotes and emailed as PDF", ""

    async def check(self) -> str:
        items = await self.get_items()
        customers = self._read_customers()
        return f"Price list: {len(items)} items · {len(customers)} known customers · {len(list(self.quotes_dir.glob('*.json')))} quotes so far"

    # --- masters --------------------------------------------------------------------------
    async def get_items(self) -> list[CatalogItem]:
        path = self.price_list
        if not path:
            raise ConnectorError(f"No price list found in {self.dir} — add price_list.xlsx", retryable=False)
        if self._items is not None and path.stat().st_mtime == self._items_mtime:
            return self._items
        try:
            rows = next(iter(load_sheets(path.read_bytes(), path.name).values()))
        except Exception as exc:
            raise ConnectorError(f"Could not read {path.name}: {exc}", retryable=False) from exc
        header, mapping = None, {}
        for i, row in enumerate(rows[:15]):
            m = _map_header(row, rows[i + 1 : i + 11])
            if {"sku", "name", "description"} & m.keys() and "customer_rate" in m:  # 'price'/'rate' map to customer_rate
                header, mapping = i, m
                break
        if header is None:
            raise ConnectorError(f"{path.name}: no header row with an item name/code and a price column", retryable=False)
        items = []
        for n, row in enumerate(rows[header + 1 :], start=1):
            cell = lambda f: row[mapping[f]] if f in mapping and mapping[f] < len(row) else None  # noqa: E731
            sku, name, desc = clean_text(cell("sku")), clean_text(cell("name")), clean_text(cell("description"))
            if not (sku or name or desc):
                continue
            items.append(CatalogItem(item_id=sku or f"row-{n}", name=name or desc or sku, sku=sku,
                                     rate=to_number(cell("customer_rate")) or 0.0, unit=clean_text(cell("unit")),
                                     description=desc if name else None))
        self._items, self._items_mtime = items, path.stat().st_mtime
        return items

    def _read_customers(self) -> list[dict]:
        if not self.customers_path.exists():
            return []
        with self.customers_path.open(newline="") as f:
            return list(csv.DictReader(f))

    async def find_customer(self, *emails: str | None, name: str | None = None) -> CustomerMatch | None:
        customers = self._read_customers()
        wanted = {e.lower() for e in emails if e}
        for c in customers:
            if c.get("email", "").lower() in wanted:
                return CustomerMatch(contact_id=c["customer_id"], contact_name=c["name"], email=c["email"], method="email")
        if name:
            for c in customers:
                if norm(c.get("name")) == norm(name):
                    return CustomerMatch(contact_id=c["customer_id"], contact_name=c["name"], email=c.get("email"), method="name")
        if not self.s.standalone_auto_create_customers or not (wanted or name):
            return None
        # Freelancers have no customer master: remember the sender as a new customer.
        email = next(iter(emails), None) if emails else None
        email = (email or "").lower() or None
        new = {"customer_id": f"CUST-{len(customers) + 1:04d}", "name": name or (email or "").split("@")[0] or "Customer",
               "email": email or "", "phone": "", "created": date.today().isoformat()}
        self.dir.mkdir(parents=True, exist_ok=True)
        is_new_file = not self.customers_path.exists()
        with self.customers_path.open("a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=CUSTOMER_FIELDS)
            if is_new_file:
                w.writeheader()
            w.writerow(new)
        return CustomerMatch(contact_id=new["customer_id"], contact_name=new["name"], email=email, method="new customer")

    # --- quotations -----------------------------------------------------------------------
    def _next_number(self, day: date) -> str:
        prefix = f"{self.s.quote_number_prefix}{day:%Y}-"
        existing = [p.stem for p in self.quotes_dir.glob(f"{prefix}*.json")]
        return f"{prefix}{len(existing) + 1:04d}"

    async def create_draft_quote(self, quote: DraftQuote) -> QuoteResult:
        self.quotes_dir.mkdir(parents=True, exist_ok=True)
        number = self._next_number(quote.quote_date)
        t = documents.totals(quote, self.s.standalone_tax_percent)
        pdf, xlsx = self.quotes_dir / f"{number}.pdf", self.quotes_dir / f"{number}.xlsx"
        result = QuoteResult(quote_id=number, quote_number=number, status="draft", total=t["total"], currency="INR",
                             attachments=[str(pdf), str(xlsx)])
        try:
            documents.write_pdf(pdf, quote, result)
            documents.write_xlsx(xlsx, quote, result)
        except Exception as exc:
            raise ConnectorError(f"Could not write quotation documents: {exc}", retryable=False) from exc
        (self.quotes_dir / f"{number}.json").write_text(json.dumps(
            {"quote": quote.model_dump(mode="json"), "result": result.model_dump(mode="json"), "totals": t}, indent=2))
        lines_path = self.quotes_dir / "quote_lines.csv"
        is_new_file = not lines_path.exists()
        with lines_path.open("a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=LINE_FIELDS)
            if is_new_file:
                w.writeheader()
            for i, l in enumerate(quote.lines, 1):
                w.writerow({"quote_number": number, "date": quote.quote_date.isoformat(), "customer_id": quote.customer_id,
                            "customer_name": quote.customer_name, "reference": quote.reference, "line_no": i,
                            "item_code": l.item_id or "", "item_name": l.name, "quantity": l.quantity, "unit": l.unit or "",
                            "rate": l.rate, "amount": round(l.quantity * l.rate, 2)})
        return result

    async def find_existing_quote(self, customer_id: str, reference: str) -> QuoteResult | None:
        for path in sorted(self.quotes_dir.glob("*.json")):
            data = json.loads(path.read_text())
            if data["quote"]["customer_id"] == customer_id and data["quote"]["reference"] == reference:
                return QuoteResult(**data["result"])
        return None
