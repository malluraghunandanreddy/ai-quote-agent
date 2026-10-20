"""Rule-based reading: units, email fields, spreadsheets (incl. legacy .xls), Word files, attachment types."""
from pathlib import Path

from app.attachments import docx_text, kind
from app.email_parser import extract_fields
from app.excel_parser import parse_excel
from app.units import unit_group, units_conflict

ROOT = Path(__file__).resolve().parent.parent


def test_units():
    assert unit_group("NOS") == unit_group("EA") == unit_group("pcs") == "piece"
    assert units_conflict("EA", "MTR") and units_conflict("EA", "PAIR")
    assert not units_conflict("NOS", "EA") and not units_conflict(None, "MTR")


def test_email_fields():
    body = ("Please quote.\n\nRFQ No: RFQ-9\nRequired by: 08/11/2026\nDelivery address: Plant 2, Autonagar\n"
            "Visakhapatnam 530012\n\nDelivery terms: Ex-works\n\nRegards,\nRavi Kumar\nDemo Customer Pvt Ltd\nMobile: +91 98480 12345\n")
    f = extract_fields("RFQ", body)
    assert f["reference"] == "RFQ-9"
    assert f["contact_phone"] == "+91 98480 12345"
    assert f["delivery_address"] == "Plant 2, Autonagar, Visakhapatnam 530012"
    assert f["delivery_terms"] == "Ex-works"
    assert f["contact_name"] == "Ravi Kumar" and f["customer_name"] == "Demo Customer Pvt Ltd"
    assert extract_fields("x", "Item 1300077549 qty 10")["contact_phone"] is None  # material code is not a phone
    assert extract_fields("Enquiry for cable ties", "")["reference"] is None


def test_customer_sample_sheet():
    r = parse_excel((ROOT / "samples" / "electrical_tail_spend.xlsx").read_bytes(), "x.xlsx")
    assert len(r.items) == 30 and r.mapped_by == "rules"
    first = r.items[0]
    assert (first.sku, first.quantity, first.unit, first.customer_rate) == ("1300077549", 10.0, "NOS", 620.0)
    assert r.items[2].customer_rate is None  # 0.0 = "please quote"
    assert first.source_row == 1


def test_legacy_xls():
    r = parse_excel((ROOT / "tests" / "fixtures" / "legacy_rfq.xls").read_bytes(), "legacy_rfq.xls")
    assert [(i.sku, i.quantity) for i in r.items] == [("1300077549", 10.0), ("1300043319", 14.0)]


def test_docx_and_kinds():
    import io
    import zipfile
    xml = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
           '<w:p><w:r><w:t>Need:</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Relay</w:t></w:r></w:p></w:tc>'
           '<w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", xml)
    assert docx_text(buf.getvalue()) == "Need:\nRelay | 10"
    assert [kind(n) for n in ("a.xls", "b.PDF", "c.jpg", "d.docx", "e.ics")] == ["sheet", "pdf", "image", "docx", None]
