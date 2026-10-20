"""Webhook connector — hand each draft quotation to any system through Zapier, Make, n8n or a custom endpoint.

Masters come from the same price list / customer files as standalone mode. Each draft is POSTed as JSON to
WEBHOOK_URL, signed with HMAC-SHA256 (header X-Quote-Agent-Signature: sha256=<hex of the raw body>) when
WEBHOOK_SECRET is set. The PDF/Excel documents are still produced and emailed to Sales.
"""
from __future__ import annotations

import hashlib
import hmac
import json

import httpx

from .. import documents
from ..schemas import DraftQuote, QuoteResult
from .base import ConnectorError
from .standalone import StandaloneConnector


class WebhookConnector(StandaloneConnector):
    key = "webhook"
    name = "Webhook (Zapier / Make / n8n / custom)"

    def readiness(self) -> tuple[bool, str, str]:
        ok, detail, fix = super().readiness()
        if not self.s.webhook_url:
            return False, "WEBHOOK_URL not set", "Set WEBHOOK_URL (and optionally WEBHOOK_SECRET) in .env"
        return ok, f"Posts drafts to {self.s.webhook_url.split('?')[0]} · {detail}", fix

    async def check(self) -> str:
        base = await super().check()
        return f"{base} · webhook target {self.s.webhook_url.split('?')[0]} (not called during checks)"

    def _payload(self, quote: DraftQuote, result: QuoteResult) -> dict:
        t = documents.totals(quote, self.s.standalone_tax_percent)
        return {
            "event": "quote.draft_created",
            "quote_number": result.quote_number,
            "status": "draft",
            "date": quote.quote_date.isoformat(),
            "expiry_date": quote.expiry_date.isoformat(),
            "reference": quote.reference,
            "customer": {"id": quote.customer_id, "name": quote.customer_name, "email": quote.customer_email,
                         "phone": quote.contact_phone, "delivery_address": quote.delivery_address},
            "delivery_terms": quote.delivery_terms,
            "lines": [l.model_dump() for l in quote.lines],
            "totals": {**t, "currency": "INR", "tax_percent": self.s.standalone_tax_percent},
            "notes": quote.notes,
        }

    async def _deliver(self, quote: DraftQuote, result: QuoteResult) -> None:
        body = json.dumps(self._payload(quote, result), separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "User-Agent": "AI-Quote-Agent/1.0"}
        if self.s.webhook_secret:
            sig = hmac.new(self.s.webhook_secret.encode(), body, hashlib.sha256).hexdigest()
            headers["X-Quote-Agent-Signature"] = f"sha256={sig}"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(self.s.webhook_url, content=body, headers=headers)
        except httpx.HTTPError as exc:
            raise ConnectorError(f"Webhook unreachable ({type(exc).__name__})") from exc
        if r.status_code >= 300:
            raise ConnectorError(f"Webhook returned {r.status_code}: {r.text[:200]}", r.status_code)

    def _mark_delivered(self, number: str) -> None:
        path = self.quotes_dir / f"{number}.json"
        data = json.loads(path.read_text())
        data["webhook_delivered"] = True
        path.write_text(json.dumps(data, indent=2))

    async def create_draft_quote(self, quote: DraftQuote) -> QuoteResult:
        if not self.s.webhook_url:
            raise ConnectorError("WEBHOOK_URL not set", retryable=False)
        # Reuse a quote whose documents were written but whose delivery failed, so retries keep one number.
        result = await StandaloneConnector.find_existing_quote(self, quote.customer_id, quote.reference)
        if result is None:
            result = await super().create_draft_quote(quote)
        await self._deliver(quote, result)
        self._mark_delivered(result.quote_number)
        return result

    async def find_existing_quote(self, customer_id: str, reference: str) -> QuoteResult | None:
        for path in sorted(self.quotes_dir.glob("*.json")):
            data = json.loads(path.read_text())
            if (data.get("webhook_delivered") and data["quote"]["customer_id"] == customer_id
                    and data["quote"]["reference"] == reference):
                return QuoteResult(**data["result"])
        return None
