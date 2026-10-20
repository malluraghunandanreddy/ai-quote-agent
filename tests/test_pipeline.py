"""End-to-end scenarios on the mock connector (rules only): flags, the three spec emails, exceptions, duplicates."""
from pathlib import Path

from tests.conftest import kinds, reset_caches, run_sample, wait_done

ROOT = Path(__file__).resolve().parent.parent


def test_excel_rfq_creates_flagged_draft_and_spec_emails(client):
    d = run_sample(client, "excel_rfq")
    assert d["status"] == "NEEDS_REVIEW" and d["erp_quote_number"].startswith("QT-MOCK-")
    assert d["contact_phone"] == "+91 98480 12345" and "Visakhapatnam" in d["delivery_address"]
    by_sku = {}
    for l in d["line_items"]:
        by_sku.setdefault(l["sku"], []).append(l)
    assert all("price_missing" in l["flags"] for l in by_sku["1300078079"]) and len(by_sku["1300078079"]) == 2
    assert all(l["rate"] == 0 for l in by_sku["1300078079"])  # never a guessed price
    cable = by_sku["1300004705"][0]
    assert "ambiguous" in cable["flags"] and "unit_mismatch" in cable["flags"]  # EA requested, sold per MTR
    assert by_sku["1300077549"][0]["flags"] is None  # exact code match, priced, same unit
    assert any("not_found" in (l["flags"] or "") for l in d["line_items"])

    notes = {n["kind"]: n for n in d["notifications"]}
    assert notes["draft_created"]["subject"] == "Draft Quotation Created – Demo Customer Pvt Ltd"
    assert notes["draft_created"]["recipients"] == "sales@example.test"
    assert notes["unmatched_products"]["subject"] == "New/Unmatched Products Identified – Quote Enquiry"
    assert notes["unmatched_products"]["recipients"] == "a@example.test, b@example.test, c@example.test"
    assert "No selling price" in notes["unmatched_products"]["body_html"]


def test_duplicate_is_blocked(client):
    run_sample(client, "excel_rfq")
    d = run_sample(client, "excel_rfq")
    assert d["status"] == "DUPLICATE" and d["notifications"] == []


def test_missing_info_emails_sales(client):
    d = run_sample(client, "bad_quantity")
    assert (d["status"], d["error_code"]) == ("EXCEPTION", "VALIDATION_ERROR")
    n = d["notifications"][0]
    assert n["kind"] == "info_request" and n["recipients"] == "sales@example.test"
    assert n["subject"] == "Additional Information Required – Customer Quotation"
    assert "quantity" in n["body_html"] and "RFQ-ELEC-0931" in n["body_html"]


def test_unknown_customer_goes_to_review(client):
    d = run_sample(client, "unknown_customer")
    assert d["error_code"] == "CUSTOMER_NOT_FOUND" and kinds(d) == ["customer_review"]


def test_unfamiliar_layout_without_ai_requests_info(client):
    d = run_sample(client, "odd_layout")
    assert d["error_code"] == "PARSE_ERROR" and kinds(d) == ["info_request"]


def test_exception_policy_stops_unknown_products(client, monkeypatch):
    monkeypatch.setenv("UNMATCHED_ITEM_POLICY", "exception")
    reset_caches()
    d = run_sample(client, "excel_rfq")
    assert d["error_code"] == "ITEM_NOT_FOUND" and d["erp_quote_number"] is None
    assert kinds(d) == ["unmatched_products"]


def test_configurable_mandatory_fields(client, monkeypatch):
    monkeypatch.setenv("REQUIRED_ENQUIRY_FIELDS", "contact_phone,delivery_address")
    reset_caches()
    d = run_sample(client, "inline_email")
    assert d["error_code"] == "VALIDATION_ERROR" and "contact phone" in d["error_message"]
    assert kinds(d) == ["info_request"]


def test_non_quote_email_is_ignored(client):
    r = client.post("/api/enquiries", data={"sender_email": "friend@example.test", "subject": "Lunch on Friday?",
                                            "body": "Are you free for lunch?"})
    d = wait_done(client, r.json()["id"])
    assert d["status"] == "IGNORED" and d["notifications"] == []


def test_multiple_attachments_are_combined(client):
    files = [("attachment", ("rfq.xlsx", (ROOT / "samples" / "electrical_tail_spend.xlsx").read_bytes())),
             ("attachment", ("legacy_rfq.xls", (ROOT / "tests" / "fixtures" / "legacy_rfq.xls").read_bytes()))]
    r = client.post("/api/enquiries", data={"sender_email": "quotes@demo.example.com", "subject": "RFQ two files",
                                            "body": "Please quote both lists."}, files=files)
    d = wait_done(client, r.json()["id"])
    assert len(d["line_items"]) == 32 and [l["line_no"] for l in d["line_items"]] == list(range(1, 33))
    assert len(d["attachments"]) == 2 and d["source_sheet"] == "Sheet1"
