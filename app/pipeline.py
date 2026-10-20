"""The quote agent: RECEIVED -> extract -> validate -> customer -> items & prices -> draft quotation -> notify.

ERP-neutral: every master-data lookup and the draft itself go through the configured connector
(app/connectors). Every stage writes to the audit log. Failures stop the run, record an exception and send
the matching notification; temporary failures (network, ERP outage, rate limit) are retried automatically.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone

from . import ai, attachments as att, db, notifier
from .config import get_settings
from .connectors import ConnectorError, get_connector
from .email_parser import ParseError, extract_fields, extract_inline_items, extract_notes, parse_date
from .excel_parser import NoItemTable, build_result, parse_excel, preview_rows
from .mapper import match_rules, norm, shortlist
from .schemas import AttachmentFile, DraftQuote, ExtractedEnquiry, ItemMatch, LineItem, QuoteLine, RawEnquiry
from .units import units_conflict
from .validator import validate

log = logging.getLogger("quote_agent")

QUOTE_WORDS = re.compile(r"\b(quote|quotation|rfq|enquiry|inquiry|estimate|price|pricing|offer|requirement)\b", re.I)
MAPPING_FIELDS = ("sku", "name", "description", "quantity", "unit", "customer_rate", "remarks", "delivery")
HEADER_FIELDS = ("customer_name", "contact_name", "customer_email", "contact_phone", "delivery_address",
                 "delivery_terms", "reference")


class StageFailure(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


def erp_failure(what: str, exc: ConnectorError) -> StageFailure:
    return StageFailure("ERP_API_ERROR", f"{what}: {exc}", retryable=exc.retryable)


def dedup_hash(raw: RawEnquiry) -> str:
    subject = re.sub(r"^\s*((re|fw|fwd)\s*:\s*)+", "", raw.subject or "", flags=re.I).strip().lower()
    body = re.sub(r"\s+", " ", raw.body_text or "").strip().lower()
    h = hashlib.sha256()
    for part in ((raw.sender_email or "").lower(), subject, body):
        h.update(part.encode())
        h.update(b"\0")
    for f in raw.attachments or ([AttachmentFile(name=raw.attachment_name or "", data=raw.attachment_bytes)]
                                 if raw.attachment_bytes else []):
        h.update(hashlib.sha256(f.data).digest())
    return h.hexdigest()


def _pick(*values):
    return next((v for v in values if v not in (None, "", [])), None)


_background: set[asyncio.Task] = set()


def run_in_background(coro) -> None:
    """Fire-and-forget with a strong reference, so the dashboard can watch stages progress live."""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


# --- entry points ---------------------------------------------------------------------

async def ingest(raw: RawEnquiry, background: bool = False) -> int:
    s = get_settings()
    h = dedup_hash(raw)
    now = db.now_iso()
    eid = db.insert(
        "enquiries", created_at=now, updated_at=now, source=raw.source, message_id=raw.message_id,
        received_at=raw.received_at.isoformat(timespec="seconds"), sender_email=raw.sender_email,
        sender_name=raw.sender_name, subject=raw.subject, body_text=raw.body_text,
        attachment_name=raw.attachment_name, attachment_blob=raw.attachment_bytes, dedup_hash=h,
        status="RECEIVED", erp_connector=s.erp_connector,
    )
    files = raw.attachments or ([AttachmentFile(name=raw.attachment_name, data=raw.attachment_bytes)]
                                if raw.attachment_bytes and raw.attachment_name else [])
    for f in files:
        db.insert("attachments", enquiry_id=eid, name=f.name, content_type=f.content_type, blob=f.data)
    att_note = f" with {len(files)} attachment(s): {', '.join(f.name for f in files)}" if files else " (no attachment)"
    db.log_event(eid, "RECEIVED", f"Email from {raw.sender_email} via {raw.source}{att_note}: \"{raw.subject}\"")

    original = db.find_dedup(h)
    if original:
        msg = f"Same sender, subject, body and attachments as enquiry #{original}, which already has a draft quotation"
        db.update_enquiry(eid, status="DUPLICATE", duplicate_of=original, error_code="DUPLICATE", error_message=msg)
        db.insert("exceptions", enquiry_id=eid, created_at=db.now_iso(), code="DUPLICATE", message=msg, alerted=0)
        db.log_event(eid, "DEDUP", msg + " — skipped, no second quotation created", "warn")
        return eid

    if background:
        db.update_enquiry(eid, status="PROCESSING")
        run_in_background(process(eid))
    else:
        await process(eid)
    return eid


def _load_raw(row: dict) -> RawEnquiry:
    files = [AttachmentFile(name=a["name"], content_type=a["content_type"] or att.mime(a["name"]), data=a["blob"])
             for a in db.fetch_all("SELECT name, content_type, blob FROM attachments WHERE enquiry_id = ? ORDER BY id", (row["id"],))]
    if not files and row["attachment_blob"]:  # enquiries stored before multi-attachment support
        files = [AttachmentFile(name=row["attachment_name"] or "attachment.xlsx", data=row["attachment_blob"])]
    return RawEnquiry(
        source=row["source"], sender_email=row["sender_email"] or "", sender_name=row["sender_name"],
        subject=row["subject"] or "", body_text=row["body_text"] or "", message_id=row["message_id"],
        received_at=datetime.fromisoformat(row["received_at"]) if row["received_at"] else datetime.now(),
        attachment_name=row["attachment_name"], attachment_bytes=row["attachment_blob"], attachments=files,
    )


async def process(eid: int) -> None:
    """Run (or re-run) the pipeline for a stored enquiry, scheduling an automatic retry on temporary failures."""
    s = get_settings()
    row = db.fetch_one("SELECT * FROM enquiries WHERE id = ?", (eid,))
    raw = _load_raw(row)
    attempt = row["retry_count"] or 0
    db.update_enquiry(eid, status="PROCESSING", error_code=None, error_message=None, next_retry_at=None)
    started = time.monotonic()
    try:
        await _run(eid, raw, row["dedup_hash"])
    except StageFailure as f:
        if f.retryable and attempt < s.retry_attempts:
            _schedule_retry(eid, f, attempt + 1)
        else:
            suffix = f" (gave up after {attempt} automatic retr{'y' if attempt == 1 else 'ies'})" if f.retryable and attempt else ""
            await _fail(eid, f.code, f.message + suffix, attempts=attempt)
    except Exception as exc:  # never leave an enquiry stuck in PROCESSING
        log.exception("Pipeline crashed for enquiry %s", eid)
        f = StageFailure("INTERNAL_ERROR", f"{type(exc).__name__}: {exc}", retryable=True)
        if attempt < s.retry_attempts:
            _schedule_retry(eid, f, attempt + 1)
        else:
            await _fail(eid, f.code, f.message, attempts=attempt)
    finally:
        db.update_enquiry(eid, processing_ms=int((time.monotonic() - started) * 1000))


def _schedule_retry(eid: int, f: StageFailure, attempt: int) -> None:
    s = get_settings()
    delay = s.retry_delay_seconds * 2 ** (attempt - 1)
    when = datetime.now(timezone.utc) + timedelta(seconds=delay)
    db.update_enquiry(eid, status="RETRY_PENDING", error_code=f.code, error_message=f.message, retry_count=attempt,
                      next_retry_at=when.isoformat(timespec="seconds"))
    db.log_event(eid, "RETRY", f"{f.code}: {f.message} — automatic retry {attempt} of {s.retry_attempts} "
                               f"at {when.astimezone():%H:%M:%S}", "warn")


async def run_due_retries() -> int:
    due = db.fetch_all("SELECT id, retry_count FROM enquiries WHERE status = 'RETRY_PENDING' AND next_retry_at <= ?",
                       (db.now_iso(),))
    for r in due:
        db.log_event(r["id"], "RETRY", f"Automatic retry {r['retry_count']} starting")
        await process(r["id"])
    return len(due)


async def _fail(eid: int, code: str, message: str, attempts: int = 0) -> None:
    db.update_enquiry(eid, status="EXCEPTION", error_code=code, error_message=message, next_retry_at=None)
    db.log_event(eid, code, message, "error")
    enquiry = db.fetch_one("SELECT * FROM enquiries WHERE id = ?", (eid,))
    if code in ("VALIDATION_ERROR", "PARSE_ERROR"):
        status = await asyncio.to_thread(notifier.request_additional_info, enquiry, _missing_items(code, message))
    elif code == "CUSTOMER_NOT_FOUND":
        status = await asyncio.to_thread(notifier.customer_review, enquiry, message)
    elif code == "ITEM_NOT_FOUND":
        rows = db.fetch_all("SELECT * FROM line_items WHERE enquiry_id = ? AND flags IS NOT NULL AND flags != '' ORDER BY line_no", (eid,))
        status = await asyncio.to_thread(notifier.unmatched_products, enquiry, rows)
    else:
        status = await asyncio.to_thread(notifier.processing_failure, enquiry, code, message, attempts)
    db.insert("exceptions", enquiry_id=eid, created_at=db.now_iso(), code=code, message=message,
              alerted=int(status in ("sent", "logged")))


def _missing_items(code: str, message: str) -> list[str]:
    if code == "PARSE_ERROR":
        return [f"A readable item list (product codes or names with quantities). {message}"]
    return [m.strip() for m in message.split(";") if m.strip()]


# --- stage 1: extract ------------------------------------------------------------------

async def _read_sheet(eid: int, f: AttachmentFile) -> tuple[list[LineItem], dict, list[str], dict]:
    try:
        result = parse_excel(f.data, f.name)
        db.log_event(eid, "EXTRACT", f"{f.name}: read {len(result.items)} line(s) from sheet '{result.sheet}' — "
                                     f"columns recognised by rules ({', '.join(sorted(result.mapping))})")
    except NoItemTable as exc:
        if not ai.enabled():
            raise StageFailure("PARSE_ERROR", f"{exc} The AI layer is off (no AI API key), so unfamiliar layouts can't be read.")
        db.log_event(eid, "EXTRACT", f"{f.name}: layout not recognised by rules — asking AI to locate the item table", "warn")
        try:
            m = await ai.map_columns({name: preview_rows(rows) for name, rows in list(exc.sheets.items())[:5]})
        except ai.AIError as aexc:
            raise StageFailure("PARSE_ERROR", f"{exc} AI column mapping failed: {aexc}")
        if not m.found_item_table or m.sheet not in exc.sheets or m.quantity is None:
            raise StageFailure("PARSE_ERROR", f"{exc} The AI could not find an item table either.")
        mapping = {k: getattr(m, k) for k in MAPPING_FIELDS if getattr(m, k) is not None}
        result = build_result(exc.sheets[m.sheet], m.header_row_index, mapping, m.sheet, "ai")
        db.log_event(eid, "EXTRACT", f"{f.name}: AI mapped columns on sheet '{m.sheet}' (header row {m.header_row_index + 1}): "
                                     f"{', '.join(sorted(mapping))} — read {len(result.items)} line(s)", "success")
    except ParseError as exc:
        raise StageFailure("PARSE_ERROR", str(exc))
    source = {"source_sheet": result.sheet, "source_header_row": result.header_row,
              "source_mapping": result.mapping, "mapped_by": result.mapped_by}
    return result.items, result.meta, result.warnings, source


def _ai_items(ex: ai.AIEmailExtraction, source: str) -> list[LineItem]:
    return [LineItem(line_no=i, source=source, sku=li.sku, name=li.name, description=li.description,
                     quantity=li.quantity, quantity_raw=None if li.quantity is None else f"{li.quantity:g}",
                     unit=li.unit, customer_rate=li.customer_rate or None, remarks=li.remarks)
            for i, li in enumerate(ex.line_items, start=1)]


async def _read_document(eid: int, f: AttachmentFile) -> tuple[list[LineItem], ai.AIEmailExtraction | None]:
    """PDF / image / Word attachment. Needs AI except for Word files, where bullet lists also work by rules."""
    kind = att.kind(f.name)
    text = None
    if kind == "docx":
        try:
            text = att.docx_text(f.data)
        except Exception as exc:
            db.log_event(eid, "EXTRACT", f"{f.name}: could not open Word file ({exc})", "warn")
            return [], None
    if not ai.enabled():
        items = extract_inline_items(text) if text else []
        db.log_event(eid, "EXTRACT", f"{f.name}: {len(items)} item(s) read by rules" if items else
                     f"{f.name}: {kind.upper()} files need the AI layer — skipped", "info" if items else "warn")
        return items, None
    if kind in ("pdf", "image") and len(f.data) > att.MAX_AI_FILE_BYTES:
        db.log_event(eid, "EXTRACT", f"{f.name}: larger than 15 MB — skipped", "warn")
        return [], None
    try:
        ex = await (ai.extract_document(f.name, text=text) if text is not None
                    else ai.extract_document(f.name, file=(f.data, f.content_type if f.content_type.startswith(("image/", "application/pdf"))
                                                          else att.mime(f.name))))
    except ai.AIError as exc:
        db.log_event(eid, "EXTRACT", f"{f.name}: AI could not read it ({exc})", "warn")
        return [], None
    items = _ai_items(ex, kind)
    db.log_event(eid, "EXTRACT", f"{f.name}: AI read {len(items)} line(s) from the {kind.upper()}", "success" if items else "warn")
    return items, ex


async def _extract(eid: int, raw: RawEnquiry) -> ExtractedEnquiry | None:
    items: list[LineItem] = []
    meta: dict = {}
    warnings: list[str] = []
    source: dict = {}
    doc_extractions: list[ai.AIEmailExtraction] = []

    for f in raw.attachments:
        kind = att.kind(f.name)
        if kind == "sheet":
            sheet_items, sheet_meta, sheet_warnings, sheet_source = await _read_sheet(eid, f)
            items += sheet_items
            warnings += sheet_warnings
            meta = {**sheet_meta, **meta}
            source = source or sheet_source  # the source view follows the first spreadsheet
        elif kind in ("pdf", "image", "docx"):
            doc_items, doc_ex = await _read_document(eid, f)
            items += doc_items
            if doc_ex:
                doc_extractions.append(doc_ex)
            if doc_items and not source:
                source = {"mapped_by": "ai" if doc_ex else "rules"}

    fields = extract_fields(raw.subject, raw.body_text)
    rule_notes = extract_notes(raw.body_text)

    ai_ex = None
    if ai.enabled():
        try:
            ai_ex = await ai.extract_email(raw.subject, raw.body_text, raw.sender_email, has_attachment=bool(items))
            found = [k for k in ("customer_name", "reference", "required_by", "delivery_address", "contact_phone") if getattr(ai_ex, k)]
            db.log_event(eid, "EXTRACT", f"AI read the email body: found {', '.join(found) or 'no header fields'}"
                                         f"{f', {len(ai_ex.line_items)} inline item(s)' if ai_ex.line_items else ''}")
        except ai.AIError as exc:
            db.log_event(eid, "EXTRACT", f"AI email extraction unavailable ({exc}) — using rules only", "warn")

    if ai_ex is not None and not ai_ex.is_quote_request and not items:
        return None

    if not items:
        if ai_ex is not None and ai_ex.line_items:
            items = _ai_items(ai_ex, "email")
            db.log_event(eid, "EXTRACT", f"Took {len(items)} line item(s) written in the email body (AI)", "success")
            source = {"mapped_by": "ai"}
        else:
            items = extract_inline_items(raw.body_text)
            if items:
                db.log_event(eid, "EXTRACT", f"Took {len(items)} line item(s) from bullet points in the email body (rules)")
                source = {"mapped_by": "rules"}

    if not items and not raw.attachments and not QUOTE_WORDS.search(f"{raw.subject} {raw.body_text}"):
        return None

    for i, li in enumerate(items, start=1):  # one numbering across all attachments
        li.line_no = i

    def best(field: str):
        return _pick(fields.get(field), meta.get(field), ai_ex and getattr(ai_ex, field),
                     *(getattr(d, field) for d in doc_extractions))

    header = {f: best(f) for f in HEADER_FIELDS}
    header["contact_name"] = header["contact_name"] or raw.sender_name
    ai_dates = [parse_date(x.required_by) for x in ([ai_ex] if ai_ex else []) + doc_extractions]
    return ExtractedEnquiry(
        **header,
        required_by=_pick(fields["required_by"], meta.get("required_by"), *ai_dates),
        notes=_pick(ai_ex and ai_ex.notes, meta.get("notes"), rule_notes, *(d.notes for d in doc_extractions)),
        line_items=items,
        warnings=warnings,
        **source,
    )


# --- stage 4: items -------------------------------------------------------------------------

async def _ai_match(eid: int, lines: list[LineItem], catalog, matches: dict[int, ItemMatch]) -> None:
    s = get_settings()
    pending = [li for li in lines if matches[li.line_no].item is None]
    shortlists = {li.line_no: shortlist(li, catalog) for li in pending}
    pending = [li for li in pending if shortlists[li.line_no]]
    if not pending:
        return
    db.log_event(eid, "MAP_ITEMS", f"Asking AI to match {len(pending)} unmatched line(s) against shortlisted catalogue items")
    payload = [{"line_no": li.line_no, "sku": li.sku, "name": li.name, "description": (li.description or "")[:400], "unit": li.unit}
               for li in pending]
    candidates = {ln: [{"item_id": c.item_id, "name": c.name, "sku": c.sku, "description": (c.description or "")[:150]} for c in cands]
                  for ln, cands in shortlists.items()}
    try:
        result = await ai.match_items(payload, candidates)
    except ai.AIError as exc:
        db.log_event(eid, "MAP_ITEMS", f"AI item matching unavailable ({exc})", "warn")
        return
    accepted = 0
    for choice in result.matches:
        allowed = {c.item_id: c for c in shortlists.get(choice.line_no, [])}
        if choice.item_id in allowed and choice.confidence >= s.ai_match_min_confidence:
            matches[choice.line_no] = ItemMatch(line_no=choice.line_no, item=allowed[choice.item_id], method="ai",
                                                score=round(choice.confidence, 2))
            accepted += 1
            db.log_event(eid, "MAP_ITEMS", f"Line {choice.line_no} → {allowed[choice.item_id].name} "
                                           f"(AI, {choice.confidence:.0%}: {choice.reason})")
    db.log_event(eid, "MAP_ITEMS", f"AI matched {accepted} of {len(pending)} line(s)", "success" if accepted else "info")


def _review_reasons(li: LineItem, m: ItemMatch, rate: float) -> tuple[list[str], list[str]]:
    """(flag codes, human reasons) — what a person must check before the quotation goes out."""
    flags, reasons = [], []
    if m.item is None:
        flags.append("not_found")
        reasons.append("Not found in the product master")
    else:
        if m.method in ("fuzzy", "ai"):
            flags.append("ambiguous")
            reasons.append(f"{'AI' if m.method == 'ai' else 'Fuzzy name'} match ({m.score:.0%}) to '{m.item.name}' — please confirm")
        if rate <= 0:
            flags.append("price_missing")
            reasons.append("No selling price in the product master — price not assumed")
        if units_conflict(li.unit, m.item.unit):
            flags.append("unit_mismatch")
            reasons.append(f"Unit mismatch: customer asked in {li.unit}, product is sold per {m.item.unit} — check the quantity")
    return flags, reasons


def _line_description(li: LineItem, m: ItemMatch, reasons: list[str]) -> str:
    parts = [f"[REVIEW: {'; '.join(reasons)}]"] if reasons else []
    if li.description and li.description != li.name:
        parts.append(li.description)
    if li.sku and (m.item is None or norm(li.sku) != norm(m.item.sku)):
        parts.append(f"Customer code: {li.sku}")
    if li.remarks:
        parts.append(f"Remarks: {li.remarks}")
    if li.delivery:
        parts.append(f"Requested delivery: {li.delivery}")
    if li.customer_rate:
        parts.append(f"Customer reference price: {li.customer_rate:,.2f}")
    return "\n".join(parts)[:2000]


# --- the run ---------------------------------------------------------------------------------

async def _run(eid: int, raw: RawEnquiry, hash_: str) -> None:
    s = get_settings()
    connector = get_connector()

    # 1. Extract -------------------------------------------------------------------
    ex = await _extract(eid, raw)
    if ex is None:
        db.update_enquiry(eid, status="IGNORED", error_message="Not a quote request")
        db.log_event(eid, "CLASSIFY", "Email is not a quote request — ignored (no alert)", "warn")
        return
    db.update_enquiry(eid, customer_name=ex.customer_name, contact_name=ex.contact_name, reference=ex.reference,
                      required_by=ex.required_by.isoformat() if ex.required_by else None, notes=ex.notes,
                      contact_phone=ex.contact_phone, delivery_address=ex.delivery_address, delivery_terms=ex.delivery_terms,
                      source_sheet=ex.source_sheet, source_header_row=ex.source_header_row,
                      source_mapping=json.dumps(ex.source_mapping) if ex.source_mapping else None, mapped_by=ex.mapped_by)
    db.replace_line_items(eid, [
        {"line_no": li.line_no, "source": li.source, "sku": li.sku, "name": li.name, "description": li.description,
         "quantity": li.quantity, "unit": li.unit, "customer_rate": li.customer_rate, "source_row": li.source_row}
        for li in ex.line_items
    ])

    # 2. Validate ------------------------------------------------------------------
    vr = validate(raw, ex)
    for w in vr.warnings:
        db.log_event(eid, "VALIDATE", w, "warn")
    if not vr.ok:
        raise StageFailure("VALIDATION_ERROR", "; ".join(vr.errors))
    db.log_event(eid, "VALIDATE", f"Validation passed — {len(ex.line_items)} line(s)", "success")

    # 3. Customer ------------------------------------------------------------------
    try:
        customer = await connector.find_customer(raw.sender_email, ex.customer_email, name=ex.customer_name)
    except ConnectorError as exc:
        raise erp_failure("Customer lookup failed", exc)
    if customer is None:
        who = raw.sender_email + (f" / '{ex.customer_name}'" if ex.customer_name else "")
        raise StageFailure("CUSTOMER_NOT_FOUND", f"No active {connector.name} customer matches {who}")
    db.update_enquiry(eid, erp_customer_id=customer.contact_id, erp_customer_name=customer.contact_name)
    db.log_event(eid, "MAP_CUSTOMER", f"Customer: {customer.contact_name} (matched by {customer.method})", "success")

    # 4. Items & prices -------------------------------------------------------------
    try:
        catalog = await connector.get_items()
    except ConnectorError as exc:
        raise erp_failure("Product list failed", exc)
    matches = match_rules(ex.line_items, catalog, s.fuzzy_match_threshold)
    by_method = {k: sum(1 for m in matches.values() if m.method == k) for k in ("sku", "name", "fuzzy")}
    unmatched = sum(1 for m in matches.values() if m.item is None)
    db.log_event(eid, "MAP_ITEMS", f"Rules matched {sum(by_method.values())}/{len(matches)} line(s) "
                                   f"(code {by_method['sku']}, name {by_method['name']}, fuzzy {by_method['fuzzy']}); {unmatched} unmatched")
    if unmatched and ai.enabled():
        await _ai_match(eid, ex.line_items, catalog, matches)

    quote_lines, rows = [], []
    for li in ex.line_items:
        m = matches[li.line_no]
        price = await connector.price_for(customer, m.item, li.quantity or 0) if m.item else None
        rate = price.rate if price else 0.0
        flags, reasons = _review_reasons(li, m, rate)
        if price and price.note:
            reasons.append(price.note)
        qty = li.quantity or 0
        quote_lines.append(QuoteLine(
            item_id=m.item.item_id if m.item else None,
            name=m.item.name if m.item else (li.name or li.sku or "Item"),
            description=_line_description(li, m, reasons[:len(flags)]),
            quantity=qty, rate=rate, unit=li.unit or (m.item.unit if m.item else None),
            discount_percent=price.discount_percent if price else None,
        ))
        rows.append({"line_no": li.line_no, "source": li.source, "sku": li.sku, "name": li.name, "description": li.description,
                     "quantity": qty, "unit": li.unit, "customer_rate": li.customer_rate,
                     "erp_item_id": m.item.item_id if m.item else None, "erp_item_name": m.item.name if m.item else None,
                     "erp_sku": m.item.sku if m.item else None, "rate": rate, "amount": round(qty * rate, 2),
                     "match_method": m.method, "match_score": m.score, "source_row": li.source_row,
                     "flags": ",".join(flags) or None, "review_note": "; ".join(reasons) or None})
    db.replace_line_items(eid, rows)
    flagged = [r for r in rows if r["flags"]]
    counts = {f: sum(1 for r in rows if f in (r["flags"] or "")) for f in ("not_found", "price_missing", "ambiguous", "unit_mismatch")}
    if flagged:
        db.log_event(eid, "MAP_ITEMS", "Flagged for review: " + ", ".join(f"{n} {f.replace('_', ' ')}" for f, n in counts.items() if n), "warn")

    not_found = [r for r in rows if r["erp_item_id"] is None]
    if not_found and (s.unmatched_item_policy == "exception" or not connector.supports_unlinked_lines):
        listing = ", ".join(f"line {r['line_no']} ({r['sku'] or r['name']})" for r in not_found[:10])
        raise StageFailure("ITEM_NOT_FOUND", f"{len(not_found)} line(s) not found in {connector.name}: {listing}")

    # 5. Draft quotation (never sent) -----------------------------------------------
    today = date.today()
    reference = ex.reference or f"ENQ-{eid}"
    notes = [f"DRAFT prepared by AI Quote Agent from email \"{raw.subject}\" ({raw.sender_email}, "
             f"received {raw.received_at:%d %b %Y %H:%M}). Not sent to the customer."]
    if ex.required_by:
        notes.append(f"Required by: {ex.required_by:%d %b %Y}")
    if ex.delivery_address:
        notes.append(f"Delivery address: {ex.delivery_address}")
    if ex.delivery_terms:
        notes.append(f"Delivery terms: {ex.delivery_terms}")
    if ex.contact_name or ex.contact_phone:
        notes.append(f"Contact: {' · '.join(x for x in (ex.contact_name, ex.contact_phone) if x)}")
    if ex.notes:
        notes.append(f"Customer notes: {ex.notes}")
    draft = DraftQuote(customer_id=customer.contact_id, customer_name=customer.contact_name,
                       customer_email=customer.email or raw.sender_email, reference=reference, quote_date=today,
                       expiry_date=today + timedelta(days=s.estimate_validity_days), notes="\n".join(notes),
                       lines=quote_lines, contact_phone=ex.contact_phone, delivery_address=ex.delivery_address,
                       delivery_terms=ex.delivery_terms)

    # Duplicate guard: if an earlier attempt reached the create step, check the ERP before creating again.
    tried_before = db.fetch_one("SELECT 1 AS x FROM audit_events WHERE enquiry_id = ? AND stage = 'ESTIMATE' "
                                "AND message LIKE 'Creating draft%'", (eid,))
    quote = None
    if tried_before:
        try:
            quote = await connector.find_existing_quote(customer.contact_id, reference)
        except ConnectorError as exc:
            raise erp_failure("Duplicate check failed", exc)
        if quote:
            db.log_event(eid, "ESTIMATE", f"Found draft {quote.quote_number} from the earlier attempt — not creating a duplicate", "warn")
    if quote is None:
        db.log_event(eid, "ESTIMATE", f"Creating draft {connector.quote_label} in {connector.name} ({len(quote_lines)} lines)")
        try:
            quote = await connector.create_draft_quote(draft)
        except ConnectorError as exc:
            raise erp_failure(f"Creating the draft {connector.quote_label} failed", exc)
    if quote.status.lower() != "draft":
        db.log_event(eid, "ESTIMATE", f"{connector.name} returned status '{quote.status}', expected 'draft' — check its settings", "error")
    db.add_dedup(hash_, eid)
    status = "NEEDS_REVIEW" if flagged else "DRAFT_CREATED"
    db.update_enquiry(eid, status=status, erp_quote_id=quote.quote_id, erp_quote_number=quote.quote_number,
                      erp_quote_status=quote.status, erp_quote_url=quote.url, quote_total=quote.total, currency=quote.currency,
                      retry_count=0, next_retry_at=None)
    db.log_event(eid, "ESTIMATE", f"Draft {connector.quote_label} {quote.quote_number} created in {connector.name} "
                                  f"({quote.currency or ''} {quote.total:,.2f}, {len(quote_lines)} lines, {len(flagged)} to review) "
                                  f"— not sent to customer", "success")

    # 6. Notify --------------------------------------------------------------------
    enquiry = db.fetch_one("SELECT * FROM enquiries WHERE id = ?", (eid,))
    await asyncio.to_thread(notifier.draft_created, enquiry, rows, quote.attachments)
    product_issues = [r for r in rows if set((r["flags"] or "").split(",")) & {"not_found", "price_missing", "ambiguous"}]
    if product_issues:
        sent = await asyncio.to_thread(notifier.unmatched_products, enquiry, product_issues)
        db.insert("exceptions", enquiry_id=eid, created_at=db.now_iso(), code="UNMATCHED_PRODUCTS",
                  message=f"{len(product_issues)} product line(s) need attention (not found, no price or uncertain match)",
                  alerted=int(sent in ("sent", "logged")))
