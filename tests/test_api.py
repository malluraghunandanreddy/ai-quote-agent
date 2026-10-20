"""Dashboard API: login, approve/reject/dismiss/reprocess, setup page, price-list upload, metrics."""
from tests.conftest import reset_caches, run_sample


def test_login_required_when_password_set(client, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "pw")
    reset_caches()
    assert client.get("/api/status").status_code == 401
    assert client.post("/api/login", json={"username": "admin", "password": "wrong"}).status_code == 401
    assert client.post("/api/login", json={"username": "admin", "password": "pw"}).status_code == 200
    assert client.get("/api/status").json()["login_enabled"] is True


def test_approve_reject_and_guards(client):
    d = run_sample(client, "excel_rfq")
    assert client.post(f"/api/enquiries/{d['id']}/approve").json()["status"] == "APPROVED"
    assert client.post(f"/api/enquiries/{d['id']}/reject", json={"reason": "price change"}).json()["status"] == "REJECTED"
    bad = run_sample(client, "bad_quantity")
    assert client.post(f"/api/enquiries/{bad['id']}/approve").status_code == 409
    assert client.post(f"/api/enquiries/{bad['id']}/dismiss").json()["status"] == "DISMISSED"
    assert client.post(f"/api/enquiries/{bad['id']}/reprocess").json()["status"] == "PROCESSING"


def test_setup_switches_connector_and_hides_secrets(client):
    view = client.get("/api/setup").json()
    assert {o["key"] for o in view["erp_options"]} >= {"mock", "zoho_books", "standalone", "webhook"}
    r = client.post("/api/setup", json={"values": {"ERP_CONNECTOR": "standalone", "BUSINESS_NAME": "Acme Supplies",
                                                   "GEMINI_API_KEY": "AIza-secret"}})
    assert r.status_code == 200 and "ERP_CONNECTOR" in r.json()["changed"]
    assert client.get("/api/status").json()["erp"]["key"] == "standalone"
    gemini = [o for o in client.get("/api/setup").json()["ai_options"] if o["key"] == "gemini"][0]
    key_field = [f for f in gemini["fields"] if f["key"] == "GEMINI_API_KEY"][0]
    assert key_field["is_set"] is True and "value" not in key_field
    assert client.post("/api/setup", json={"values": {"DB_PATH": "/etc/x"}}).status_code == 422
    assert client.post("/api/setup", json={"values": {"ERP_CONNECTOR": "sap"}}).status_code == 422


def test_price_list_upload(client):
    good = "Item code,Item name,Unit,Price\nA1,Widget,NOS,10\nA2,Gadget,EA,\n"
    r = client.post("/api/setup/price-list", files={"file": ("prices.csv", good.encode())})
    assert r.status_code == 200 and r.json() == {"items": 2, "without_price": 1}
    bad = client.post("/api/setup/price-list", files={"file": ("prices.csv", b"just,some\nrandom,cells\n")})
    assert bad.status_code == 422
    again = client.post("/api/setup/price-list", files={"file": ("prices.csv", good.encode())})
    assert again.json()["items"] == 2  # the good list survived the bad upload


def test_metrics_shape(client):
    run_sample(client, "excel_rfq")
    run_sample(client, "bad_quantity")
    m = client.get("/api/metrics").json()
    assert m["total"] == 2 and m["drafts"] == 1 and m["open_exceptions"] == 1
    assert m["funnel"]["notified"] == 1 and m["flag_counts"]["price_missing"] == 2
