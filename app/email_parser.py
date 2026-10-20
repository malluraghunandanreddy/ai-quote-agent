"""Email handling: parse RFC822 messages and extract quote header fields from body text."""
from __future__ import annotations

import email
import re
from datetime import date, datetime
from email import policy
from email.utils import parseaddr, parsedate_to_datetime
from html import unescape

import pandas as pd

from . import attachments as att
from .schemas import AttachmentFile, LineItem, RawEnquiry

EXCEL_EXTENSIONS = (".xlsx", ".xlsm", ".xls", ".csv")
AGENT_HEADER = "X-Quote-Agent"  # stamped on every mail we send, so the poller never re-ingests it
# Subjects of the agent's own notifications (spec section 3) — a second loop guard besides the header.
AGENT_SUBJECTS = (
    "Additional Information Required – Customer Quotation",
    "New/Unmatched Products Identified – Quote Enquiry",
    "Draft Quotation Created – ",
    "Customer Review Required – Quote Enquiry",
    "Quote Agent Processing Failure",
    "[Quote Agent]",
)


class ParseError(Exception):
    pass


# --- RFC822 ---------------------------------------------------------------------

def _html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style).*?</\1>", "", html)
    html = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", html)
    return unescape(re.sub(r"<[^>]+>", "", html))


def is_agent_generated(msg: email.message.EmailMessage) -> bool:
    subject = str(msg.get("Subject") or "").strip()
    return bool(msg.get(AGENT_HEADER)) or subject.startswith(AGENT_SUBJECTS)


def parse_eml(data: bytes, source: str = "imap") -> RawEnquiry:
    msg = email.message_from_bytes(data, policy=policy.default)
    sender_name, sender_email = parseaddr(msg.get("From", ""))

    body_part = msg.get_body(preferencelist=("plain", "html"))
    body = ""
    if body_part is not None:
        body = body_part.get_content()
        if body_part.get_content_subtype() == "html":
            body = _html_to_text(body)

    files: list[AttachmentFile] = []
    for part in msg.iter_attachments():
        filename = part.get_filename() or ""
        if att.kind(filename):
            files.append(AttachmentFile(name=filename, content_type=part.get_content_type(),
                                        data=part.get_payload(decode=True) or b""))
    primary = next((f for f in files if att.kind(f.name) == "sheet"), files[0] if files else None)

    try:
        received_at = parsedate_to_datetime(msg["Date"]) if msg["Date"] else datetime.now()
    except (TypeError, ValueError):
        received_at = datetime.now()

    return RawEnquiry(
        source=source,
        sender_email=sender_email.lower(),
        sender_name=sender_name or None,
        subject=str(msg.get("Subject", "")),
        body_text=body.strip(),
        message_id=msg.get("Message-ID"),
        received_at=received_at,
        attachment_name=primary.name if primary else None,
        attachment_bytes=primary.data if primary else None,
        attachments=files,
    )


# --- field extraction ---------------------------------------------------------

_LABELS = {
    "customer_name": r"company(?:\s+name)?|customer(?:\s+name)?|client|organi[sz]ation|firm",
    "contact_name": r"contact(?:\s+person)?|attn|attention|requested\s+by",
    "customer_email": r"e-?mail",
    "reference": r"rfq(?:\s+(?:no|number|#))?|ref(?:erence)?(?:\s+(?:no|number|#))?|enquiry\s+(?:no|number|#)|po(?:\s+(?:no|number|#))?",
    "required_by": r"required\s+by|delivery\s+date|deliver\s+by|need(?:ed)?\s+by|due\s+date|required\s+date",
    "contact_phone": r"phone|mobile|mob|tel|telephone|ph|cell|whatsapp|contact\s+(?:no|number)",
    "delivery_terms": r"delivery\s+terms|incoterms?|freight|shipping\s+terms|delivery\s+basis|terms\s+of\s+delivery",
}
_ADDRESS_LABEL = re.compile(
    r"^\s*(?:delivery\s+address|shipping\s+address|ship\s+to|deliver\s+to|delivery\s+to|site\s+address|"
    r"delivery\s+location|consignee(?:\s+address)?)\s*[:\-–]\s*(?P<first>.*)$", re.I)
_PHONE = re.compile(r"(\+?\d[\d\s\-()]{8,}\d)")
_SIGNOFF = re.compile(r"^\s*(?:best\s+|kind\s+|warm\s+)?(?:regards|thanks|thank\s+you|sincerely|cheers)[,!.]?\s*$", re.I)
# Reference tokens must contain a digit, so "Enquiry for ..." is not read as ref "ENQUIRY".
_SUBJECT_REF = re.compile(r"\b((?:RFQ|REF|PO|PR|ENQ)[-/#:\s]*[A-Z0-9\-/]*\d[A-Z0-9\-/]*)", re.I)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def parse_date(value) -> date | None:
    """Parse a date from text or an Excel cell. ISO first, then day-first (Indian convention)."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    iso = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", text)
    if iso:
        try:
            return date(*map(int, iso.groups()))
        except ValueError:
            return None
    parsed = pd.to_datetime(text, dayfirst=True, errors="coerce")
    return None if pd.isna(parsed) else parsed.date()


def label_value(text: str, field: str) -> str | None:
    """Find `Label: value` (or `Label - value`) on its own line."""
    pattern = rf"^\s*(?:{_LABELS[field]})\s*[:\-–]\s*(.+?)\s*$"
    m = re.search(pattern, text, re.I | re.M)
    return m.group(1).strip() if m else None


def _clean_phone(text: str | None) -> str | None:
    if not text:
        return None
    m = _PHONE.search(text)
    if not m or sum(c.isdigit() for c in m.group(1)) < 10:
        return None
    return re.sub(r"\s{2,}", " ", m.group(1)).strip()


def address_block(body: str) -> tuple[str | None, set[int]]:
    """'Delivery address:' plus following lines until a blank line or another label (max 4 lines)."""
    lines = body.splitlines()
    any_label = re.compile(rf"^\s*(?:{'|'.join(_LABELS.values())})\s*[:\-–]", re.I)
    for i, ln in enumerate(lines):
        m = _ADDRESS_LABEL.match(ln)
        if not m:
            continue
        parts, used = ([m.group("first").strip()] if m.group("first").strip() else []), {i}
        for j in range(i + 1, min(i + 5, len(lines))):
            nxt = lines[j].strip()
            if not nxt or any_label.match(nxt) or _ADDRESS_LABEL.match(nxt) or _SIGNOFF.match(nxt):
                break
            parts.append(nxt)
            used.add(j)
        return (", ".join(parts) or None), used
    return None, set()


def extract_fields(subject: str, body: str) -> dict:
    fields = {f: label_value(body, f) for f in _LABELS}
    fields["contact_phone"] = _clean_phone(fields["contact_phone"])
    fields["delivery_address"], _ = address_block(body)

    if not fields["reference"]:
        m = _SUBJECT_REF.search(subject) or _SUBJECT_REF.search(body)
        if m:
            fields["reference"] = re.sub(r"\s+", " ", m.group(1)).strip().upper()

    if fields["customer_email"]:
        m = _EMAIL.search(fields["customer_email"])
        fields["customer_email"] = m.group(0).lower() if m else None

    # Signature block: "Regards,\nName\nCompany"
    lines = [ln.strip() for ln in body.splitlines()]
    for i, ln in enumerate(lines):
        if _SIGNOFF.match(ln):
            if not fields["contact_phone"]:
                fields["contact_phone"] = next((p for p in map(_clean_phone, lines[i + 1 : i + 7]) if p), None)
            sig = [x for x in lines[i + 1 : i + 4] if x and not _EMAIL.search(x) and not re.search(r"\d{6,}", x)]
            if sig and not fields["contact_name"]:
                fields["contact_name"] = sig[0]
            if len(sig) > 1 and not fields["customer_name"]:
                fields["customer_name"] = sig[1]
            break

    fields["required_by"] = parse_date(fields["required_by"])
    return fields


def extract_notes(body: str) -> str | None:
    """Body text minus greeting, labelled fields, item bullets and signature."""
    keep: list[str] = []
    label_re = re.compile(rf"^\s*(?:{'|'.join(_LABELS.values())})\s*[:\-–]", re.I)
    _, address_lines = address_block(body)
    for i, ln in enumerate(body.splitlines()):
        if _SIGNOFF.match(ln):
            break
        if i in address_lines:
            continue
        s = ln.strip()
        if not s or label_re.match(s) or re.match(r"^(hi|hello|dear)\b", s, re.I) or _ITEM_BULLET.match(s):
            continue
        keep.append(s)
    text = " ".join(keep).strip()
    return text[:1500] or None


# --- inline items (fallback when no spreadsheet is attached) ------------------

_ITEM_BULLET = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+(?P<text>.+)$")
_QTY = re.compile(
    r"(?:qty|quantity)\s*[:=]?\s*(?P<a>\d+(?:\.\d+)?)"
    r"|[x×]\s*(?P<b>\d+(?:\.\d+)?)\b"
    r"|(?P<c>\d+(?:\.\d+)?)\s*(?P<unit>pcs|pc|nos|no|units|ea|pieces|rolls|boxes|sets|pairs|pair|packets|packet|pkts|pkt"
    r"|kg|metres|meters|mtrs|mtr|m|ltr)\b",
    re.I,
)
_SKU = re.compile(r"\b([A-Z]{2,}[-_]?\d{2,}[A-Z0-9\-]*)\b")


def extract_inline_items(body: str) -> list[LineItem]:
    items: list[LineItem] = []
    for ln in body.splitlines():
        m = _ITEM_BULLET.match(ln)
        if not m:
            continue
        text = m.group("text")
        q = _QTY.search(text)
        if not q:
            continue
        qty = float(q.group("a") or q.group("b") or q.group("c"))
        sku_m = _SKU.search(text)
        name = _QTY.sub("", text)
        if sku_m:
            name = name.replace(sku_m.group(1), "")
        name = re.sub(r"[()\[\]:,–\-]+\s*$", "", re.sub(r"\s{2,}", " ", name)).strip(" -–:()")
        items.append(
            LineItem(
                line_no=len(items) + 1,
                source="email",
                sku=sku_m.group(1) if sku_m else None,
                name=name or None,
                quantity=qty,
                quantity_raw=q.group(0),
                unit=(q.group("unit") or None),
            )
        )
    return items
