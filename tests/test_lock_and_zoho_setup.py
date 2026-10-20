"""Customer installation lock + the Setup page's Zoho Books connect and demo-data flows (fake Zoho)."""
import json

import httpx
import pytest

from tests.conftest import reset_caches


@pytest.fixture
def locked(monkeypatch):
    monkeypatch.setenv("LOCK_ERP_CONNECTOR", "zoho_books")
    monkeypatch.setenv("LOCK_AI_PROVIDER", "gemini")
    monkeypatch.setenv("ERP_CONNECTOR", "mock")  # demo data until Zoho is connected
    reset_caches()


def test_locked_setup_shows_only_zoho_and_gemini(client, locked):
    v = client.get("/api/setup").json()
    assert v["erp_locked"] and [o["key"] for o in v["erp_options"]] == ["zoho_books"] and v["erp_demo"] is True
    assert v["ai_locked"] and [o["key"] for o in v["ai_options"]] == ["gemini"]
    assert client.get("/api/status").json()["erp"]["locked_to"] == "zoho_books"


def test_locked_rejects_other_systems_but_allows_demo(client, locked):
    assert client.post("/api/setup", json={"values": {"ERP_CONNECTOR": "standalone"}}).status_code == 422
    assert client.post("/api/setup", json={"values": {"AI_PROVIDER": "anthropic"}}).status_code == 422
    assert client.post("/api/setup", json={"values": {"ERP_CONNECTOR": "mock"}}).status_code == 200
    assert client.post("/api/setup", json={"values": {"ERP_CONNECTOR": "zoho_books"}}).status_code == 200
    assert client.get("/api/status").json()["erp"]["key"] == "zoho_books"


def test_lock_overrides_a_stray_setting(monkeypatch):
    monkeypatch.setenv("LOCK_ERP_CONNECTOR", "zoho_books")
    monkeypatch.setenv("ERP_CONNECTOR", "webhook")
    reset_caches()
    from app.config import get_settings
    assert get_settings().erp_connector == "zoho_books"


def fake_zoho(monkeypatch, orgs, token_error=None, posted=None):
    from app import setup
    from app.connectors import zoho_books

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path.endswith("/oauth/v2/token"):
            if req.url.params.get("grant_type") == "authorization_code":
                if token_error:
                    return httpx.Response(200, json={"error": token_error})
                return httpx.Response(200, json={"access_token": "at", "refresh_token": "rt-123", "expires_in": 3600})
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        if path.endswith("/organizations"):
            return httpx.Response(200, json={"code": 0, "organizations": orgs})
        if path.endswith("/contacts") and req.method == "GET":
            return httpx.Response(200, json={"code": 0, "contacts": []})
        if path.endswith("/items") and req.method == "GET":
            return httpx.Response(200, json={"code": 0, "page_context": {"has_more_page": False}, "items": [
                {"item_id": "1", "name": "Existing", "sku": "1300077549", "rate": 640}]})
        if req.method == "POST" and posted is not None:
            body = json.loads(req.content)
            posted.append((path, body))
            if body.get("sku") == "EAT-9E3000XL":
                return httpx.Response(400, json={"code": 1001, "message": "HSN/SAC is mandatory"})
            return httpx.Response(201, json={"code": 0})
        return httpx.Response(404, json={"code": 1, "message": f"unexpected {req.method} {path}"})

    real = httpx.AsyncClient
    factory = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)  # noqa: E731
    monkeypatch.setattr(setup.httpx, "AsyncClient", factory)
    monkeypatch.setattr(zoho_books.httpx, "AsyncClient", factory)


def test_connect_single_org_saves_and_leaves_demo(client, locked, monkeypatch, isolated):
    fake_zoho(monkeypatch, [{"organization_id": 600, "name": "Example Demo"}])
    r = client.post("/api/setup/zoho/connect", json={"dc": "in", "client_id": "cid", "client_secret": "sec", "code": "1000.x"})
    assert r.status_code == 200 and r.json() == {"connected": True, "organization": {"id": "600", "name": "Example Demo"}}
    env = (isolated / ".env").read_text()
    assert "ZOHO_REFRESH_TOKEN=rt-123" in env and "ZOHO_ORGANIZATION_ID=600" in env and "ERP_CONNECTOR=zoho_books" in env
    status = client.get("/api/status").json()
    assert status["erp"]["key"] == "zoho_books"
    assert [c for c in status["readiness"] if c["key"] == "erp"][0]["ok"] is True
    zoho = [o for o in client.get("/api/setup").json()["erp_options"] if o["key"] == "zoho_books"][0]
    assert all("value" not in f for f in zoho["fields"] if f["type"] == "secret")  # secrets never returned


def test_connect_multiple_orgs_then_choose(client, monkeypatch):
    fake_zoho(monkeypatch, [{"organization_id": 1, "name": "A"}, {"organization_id": 2, "name": "B"}])
    r = client.post("/api/setup/zoho/connect", json={"client_id": "c", "client_secret": "s", "code": "x"}).json()
    assert r["connected"] is False and [o["id"] for o in r["choose"]] == ["1", "2"]
    assert client.post("/api/setup/zoho/connect", json={"pending": r["pending"], "organization_id": "9"}).status_code == 422
    r2 = client.post("/api/setup/zoho/connect", json={"client_id": "c", "client_secret": "s", "code": "y"}).json()
    done = client.post("/api/setup/zoho/connect", json={"pending": r2["pending"], "organization_id": "2"}).json()
    assert done["organization"] == {"id": "2", "name": "B"}


def test_expired_code_gives_a_clear_message(client, monkeypatch):
    fake_zoho(monkeypatch, [], token_error="invalid_code")
    r = client.post("/api/setup/zoho/connect", json={"client_id": "c", "client_secret": "s", "code": "old"})
    assert r.status_code == 422 and "generate a new one" in r.json()["detail"]


def test_demo_data_preview_and_create(client, monkeypatch):
    for k, v in {"ERP_CONNECTOR": "zoho_books", "ZOHO_CLIENT_ID": "c", "ZOHO_CLIENT_SECRET": "s",
                 "ZOHO_REFRESH_TOKEN": "rt", "ZOHO_ORGANIZATION_ID": "600"}.items():
        monkeypatch.setenv(k, v)
    reset_caches()
    posted = []
    fake_zoho(monkeypatch, [], posted=posted)
    preview = client.post("/api/setup/zoho/demo-data", json={"apply": False}).json()
    assert any("Customer:" in t for t in preview["todo"]) and any("Existing" not in t for t in preview["todo"])
    assert any("1300077549" not in t for t in preview["todo"]) and posted == []  # preview writes nothing
    created = client.post("/api/setup/zoho/demo-data", json={"apply": True, "hsn": "8536"}).json()
    failed = [x for x in created["results"] if not x["ok"]]
    assert len(failed) == 1 and "HSN" in failed[0]["detail"]  # Zoho's own validation message is shown
    assert all(b.get("hsn_or_sac") == "8536" for p, b in posted if p.endswith("/items"))
