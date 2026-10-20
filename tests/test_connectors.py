"""Plug-and-play connectors: standalone (PDF/Excel by email), webhook, and Zoho Books against a fake API."""
import hashlib
import hmac
import json
from pathlib import Path

import httpx
import pytest

from app.connectors import ConnectorError, load
from tests.conftest import kinds, reset_caches, run_sample


def use(monkeypatch, **env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    reset_caches()


def test_unknown_connector_is_rejected():
    with pytest.raises(ConnectorError):
        load("nope")


def test_standalone_mode_emails_pdf_and_excel(client, monkeypatch, isolated):
    use(monkeypatch, ERP_CONNECTOR="standalone", STANDALONE_TAX_PERCENT="18", BUSINESS_NAME="Test Traders")
    d = run_sample(client, "excel_rfq")
    assert d["status"] == "NEEDS_REVIEW" and d["erp_quote_number"].startswith("QT-") and d["erp_quote_url"] is None
    draft = [n for n in d["notifications"] if n["kind"] == "draft_created"][0]
    assert ".pdf" in draft["error"] and ".xlsx" in draft["error"]  # attachment list is recorded with the email
    r = client.get(f"/api/enquiries/{d['id']}/quote-document?fmt=pdf")
    assert r.status_code == 200 and r.content[:4] == b"%PDF"
    customers = (isolated / "standalone" / "customers.csv").read_text()
    assert "quotes@demo.example.com" in customers  # sender remembered as a new customer
    assert any("matched by new customer" in e["message"] for e in d["events"])


def test_webhook_posts_signed_json(client, monkeypatch):
    use(monkeypatch, ERP_CONNECTOR="webhook", WEBHOOK_URL="https://hooks.example.test/q", WEBHOOK_SECRET="k")
    from app.connectors import webhook
    seen = []
    real = httpx.AsyncClient
    monkeypatch.setattr(webhook.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(lambda req: (seen.append(req), httpx.Response(200))[1]), **kw))
    d = run_sample(client, "excel_rfq")
    assert d["erp_quote_number"] and len(seen) == 1
    payload = json.loads(seen[0].content)
    assert payload["event"] == "quote.draft_created" and payload["quote_number"] == d["erp_quote_number"]
    assert seen[0].headers["X-Quote-Agent-Signature"] == "sha256=" + hmac.new(b"k", seen[0].content, hashlib.sha256).hexdigest()


def test_zoho_books_connector_against_fake_api(client, monkeypatch):
    use(monkeypatch, ERP_CONNECTOR="zoho_books", ZOHO_DC="in", ZOHO_CLIENT_ID="id", ZOHO_CLIENT_SECRET="sec",
        ZOHO_REFRESH_TOKEN="tok", ZOHO_ORGANIZATION_ID="600")
    from app.connectors import zoho_books
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        path = req.url.path
        if path.endswith("/oauth/v2/token"):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        assert req.url.params["organization_id"] == "600" and req.headers["Authorization"] == "Zoho-oauthtoken at"
        if path.endswith("/contacts"):
            hit = req.url.params.get("email") == "quotes@demo.example.com"
            return httpx.Response(200, json={"code": 0, "contacts": [{"contact_id": "77", "contact_name": "Demo Customer Pvt Ltd",
                                                                      "email": "quotes@demo.example.com"}] if hit else []})
        if path.endswith("/items"):
            return httpx.Response(200, json={"code": 0, "page_context": {"has_more_page": False}, "items": [
                {"item_id": "9", "name": "Finder Relay 55.34", "sku": "1300077549", "rate": 640, "unit": "NOS"}]})
        if path.endswith("/estimates") and req.method == "POST":
            assert req.url.params["send"] == "false"  # never emailed to the customer
            body = json.loads(req.content)
            assert body["reference_number"] == "RFQ-ELEC-0918" and body["customer_id"] == "77"
            assert any("name" in l and "item_id" not in l for l in body["line_items"])  # unlinked lines allowed
            return httpx.Response(201, json={"code": 0, "estimate": {"estimate_id": "5001", "estimate_number": "EST-0001",
                                                                     "status": "draft", "total": 6400, "currency_code": "INR"}})
        return httpx.Response(404, json={"code": 1, "message": f"unexpected {req.method} {path}"})

    real = httpx.AsyncClient
    monkeypatch.setattr(zoho_books.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    d = run_sample(client, "excel_rfq")
    assert d["erp_quote_number"] == "EST-0001" and d["erp_customer_id"] == "77"
    assert d["erp_quote_url"] == "https://books.zoho.in/app/600#/quotes/5001"
    assert "draft_created" in kinds(d)
