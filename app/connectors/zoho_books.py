"""Zoho Books REST API v3 connector (Zoho calls quotations "estimates").

Safety: estimates are created with `send=false` and this module never calls any Zoho
email/send/mark-as-sent endpoint, so a draft can never reach the customer from here.
"""
from __future__ import annotations

import asyncio
import time

import httpx

from ..config import get_settings
from ..mapper import norm
from ..schemas import CatalogItem, CustomerMatch, DraftQuote, QuoteLine, QuoteResult
from .base import Connector, ConnectorError

ITEM_CACHE_SECONDS = 600
TRANSIENT_STATUSES = {429, 500, 502, 503, 504}


def _line_payload(line: QuoteLine) -> dict:
    out = {"quantity": line.quantity, "rate": line.rate, "description": line.description or ""}
    if line.discount_percent:
        out["discount"] = f"{line.discount_percent}%"
    if line.item_id:
        out["item_id"] = line.item_id
    else:  # unlinked line: product not in the item master
        out["name"] = (line.name or "Item")[:100]
        if line.unit:
            out["unit"] = line.unit[:20]
    return out


def _pick_customer(contacts: list[dict], method: str) -> CustomerMatch | None:
    for c in contacts:
        if c.get("contact_type", "customer") == "customer" and c.get("status", "active") == "active":
            return CustomerMatch(contact_id=str(c["contact_id"]), contact_name=c["contact_name"], email=c.get("email"), method=method)
    return None


class ZohoBooksConnector(Connector):
    key = "zoho_books"
    name = "Zoho Books"
    quote_label = "estimate"

    def __init__(self) -> None:
        self.s = get_settings()
        self._token: str | None = None
        self._token_expiry = 0.0
        self._items: list[CatalogItem] | None = None
        self._items_at = 0.0
        self._lock = asyncio.Lock()

    # --- config -------------------------------------------------------------------------
    @property
    def api_base(self) -> str:
        return f"https://www.zohoapis.{self.s.zoho_dc}/books/v3"

    @property
    def accounts_url(self) -> str:
        return f"https://accounts.zoho.{self.s.zoho_dc}"

    def quote_url(self, estimate_id: str) -> str:
        # Zoho Books labels estimates as "Quotes" in the web app.
        return f"https://books.zoho.{self.s.zoho_dc}/app/{self.s.zoho_org_id}#/quotes/{estimate_id}"

    def readiness(self) -> tuple[bool, str, str]:
        missing = [k for k, v in {"ZOHO_CLIENT_ID": self.s.zoho_client_id, "ZOHO_CLIENT_SECRET": self.s.zoho_client_secret,
                                  "ZOHO_REFRESH_TOKEN": self.s.zoho_refresh_token, "ZOHO_ORGANIZATION_ID": self.s.zoho_org_id}.items() if not v]
        if missing:
            return False, "Missing: " + ", ".join(missing), "Setup → Connect Zoho Books (paste the Self Client code)"
        return True, f"Organization {self.s.zoho_org_id} (data centre .{self.s.zoho_dc})", ""

    # --- HTTP -----------------------------------------------------------------------------
    async def _access_token(self, force: bool = False) -> str:
        async with self._lock:
            if self._token and not force and time.time() < self._token_expiry:
                return self._token
            ok, detail, _ = self.readiness()
            if not ok:
                raise ConnectorError(f"Zoho credentials missing ({detail})", retryable=False)
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    r = await client.post(f"{self.accounts_url}/oauth/v2/token", params={
                        "refresh_token": self.s.zoho_refresh_token, "client_id": self.s.zoho_client_id,
                        "client_secret": self.s.zoho_client_secret, "grant_type": "refresh_token"})
            except httpx.HTTPError as exc:
                raise ConnectorError(f"Could not reach Zoho accounts ({type(exc).__name__})") from exc
            data = r.json() if r.content else {}
            if "access_token" not in data:
                raise ConnectorError(f"Zoho token refresh failed: {data.get('error', r.text[:200])}", r.status_code,
                                     retryable=r.status_code >= 500)
            self._token = data["access_token"]
            self._token_expiry = time.time() + int(data.get("expires_in", 3600)) - 120
            return self._token

    async def request(self, method: str, path: str, *, params: dict | None = None, json_body: dict | None = None) -> dict:
        query = {"organization_id": self.s.zoho_org_id, **(params or {})}
        # Never auto-retry a create (POST): if Zoho created the estimate but the reply was lost, a retry would
        # duplicate it. Whole-enquiry retries handle that case via find_existing_quote().
        quick_retries = self.s.zoho_http_retries if method == "GET" else 0
        attempt, refreshed, force = 0, False, False
        while True:
            token = await self._access_token(force=force)
            force = False
            try:
                async with httpx.AsyncClient(base_url=self.api_base, timeout=30) as client:
                    r = await client.request(method, path, params=query, json=json_body,
                                             headers={"Authorization": f"Zoho-oauthtoken {token}"})
            except httpx.HTTPError as exc:
                if attempt < quick_retries:
                    attempt += 1
                    await asyncio.sleep(2 ** (attempt - 1))
                    continue
                raise ConnectorError(f"Could not reach Zoho Books ({type(exc).__name__})") from exc
            if r.status_code == 401 and not refreshed:
                refreshed = force = True  # token revoked/expired early — refresh once (request was not processed)
                continue
            if r.status_code in TRANSIENT_STATUSES and attempt < quick_retries:
                attempt += 1
                await asyncio.sleep(2 ** (attempt - 1))
                continue
            try:
                data = r.json()
            except ValueError:
                raise ConnectorError(f"Zoho returned non-JSON ({r.status_code}): {r.text[:200]}", r.status_code)
            if r.status_code >= 400 or data.get("code", 0) != 0:
                raise ConnectorError(f"Zoho {method} {path}: {data.get('message', r.text[:200])}", r.status_code, data.get("code"))
            return data

    # --- masters ----------------------------------------------------------------------------
    async def find_customer(self, *emails: str | None, name: str | None = None) -> CustomerMatch | None:
        for email in dict.fromkeys(e.lower() for e in emails if e):
            data = await self.request("GET", "/contacts", params={"email": email})
            if match := _pick_customer(data.get("contacts", []), "email"):
                return match
        if name:
            data = await self.request("GET", "/contacts", params={"contact_name_contains": name})
            contacts = data.get("contacts", [])
            exact = [c for c in contacts if norm(c.get("contact_name")) == norm(name)]
            return _pick_customer(exact or (contacts if len(contacts) == 1 else []), "name")
        return None

    async def get_items(self) -> list[CatalogItem]:
        if self._items is not None and time.time() - self._items_at < ITEM_CACHE_SECONDS:
            return self._items
        items, page = [], 1
        while True:
            data = await self.request("GET", "/items", params={"page": page, "per_page": 200, "filter_by": "Status.Active"})
            for it in data.get("items", []):
                items.append(CatalogItem(item_id=str(it["item_id"]), name=it.get("name", ""), sku=it.get("sku") or None,
                                         rate=float(it.get("rate") or 0), unit=it.get("unit") or None,
                                         description=it.get("description") or None))
            if not data.get("page_context", {}).get("has_more_page"):
                break
            page += 1
        self._items, self._items_at = items, time.time()
        return items

    # --- quotations ---------------------------------------------------------------------------
    def _result(self, est: dict) -> QuoteResult:
        return QuoteResult(quote_id=str(est["estimate_id"]), quote_number=est.get("estimate_number", ""),
                           status=est.get("status", "draft"), total=float(est.get("total") or 0),
                           currency=est.get("currency_code"), url=self.quote_url(str(est["estimate_id"])))

    async def create_draft_quote(self, quote: DraftQuote) -> QuoteResult:
        body = {
            "customer_id": quote.customer_id,
            "date": quote.quote_date.isoformat(),
            "expiry_date": quote.expiry_date.isoformat(),
            "reference_number": quote.reference[:50],
            "line_items": [_line_payload(l) for l in quote.lines],
            "notes": quote.notes[:2000],
        }
        data = await self.request("POST", "/estimates", params={"send": "false"}, json_body=body)
        return self._result(data["estimate"])

    async def find_existing_quote(self, customer_id: str, reference: str) -> QuoteResult | None:
        data = await self.request("GET", "/estimates", params={"customer_id": customer_id, "reference_number": reference[:50]})
        drafts = [e for e in data.get("estimates", []) if e.get("status") == "draft"]
        return self._result(drafts[0]) if drafts else None

    async def check(self) -> str:
        data = await self.request("GET", "/organizations")
        orgs = {str(o["organization_id"]): o.get("name") for o in data.get("organizations", [])}
        if self.s.zoho_org_id not in orgs:
            raise ConnectorError(f"Organization {self.s.zoho_org_id} not accessible; token can see {list(orgs) or 'none'}", retryable=False)
        return f"Connected to '{orgs[self.s.zoho_org_id]}' ({len(await self.get_items())} active items)"
