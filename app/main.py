"""FastAPI app: audit dashboard at GET /, JSON API under /api, background inbox poller and retry scheduler."""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import attachments as att, auth, db, inbox, pipeline, readiness, setup
from .config import SAMPLES_DIR, STATIC_DIR, get_settings
from .connectors import ConnectorError, get_connector
from .email_parser import ParseError, parse_eml
from .excel_parser import clean_text, load_sheets
from .schemas import AttachmentFile, RawEnquiry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("quote_agent")

MAX_UPLOAD_BYTES = 15 * 1024 * 1024

SAMPLES = {
    "excel_rfq": ("Customer RFQ + Excel (30 lines)", "rfq_with_excel.eml"),
    "inline_email": ("Items typed in the email body", "rfq_inline_items.eml"),
    "odd_layout": ("Unfamiliar Excel layout (AI maps it)", "rfq_odd_layout.eml"),
    "pdf_rfq": ("RFQ as a PDF attachment (AI reads it)", "rfq_pdf.eml"),
    "bad_quantity": ("Bad quantities → additional-info email", "rfq_bad_quantity.eml"),
    "unknown_customer": ("Unknown sender → customer review", "rfq_unknown_customer.eml"),
}

# What an operator should do for each exception, shown in the exceptions queue.
EXCEPTION_HINTS = {
    "PARSE_ERROR": "The attachment couldn't be read. Ask the customer for an Excel or PDF with item codes and quantities "
                   "(Sales has been emailed), or turn on the AI layer, then Reprocess.",
    "VALIDATION_ERROR": "Information is missing or invalid — Sales has been emailed the list. The customer's corrected email "
                        "is processed automatically.",
    "CUSTOMER_NOT_FOUND": "Create this customer in {erp} with the sender's email, then Reprocess.",
    "ITEM_NOT_FOUND": "Add the missing products in {erp} (stakeholders were emailed the list), or set "
                      "'Products not in the master' to free_text in Setup, then Reprocess.",
    "ERP_API_ERROR": "{erp} rejected the request. Check the message (GST fields, permissions, credentials), fix it, then Reprocess.",
    "ZOHO_API_ERROR": "{erp} rejected the request. Check the message, fix it, then Reprocess.",
    "INTERNAL_ERROR": "Unexpected error. Check the server log, then Reprocess.",
}

FIELD_LABELS = {"sku": "Item code", "name": "Item name", "description": "Description", "quantity": "Quantity",
                "unit": "UOM", "customer_rate": "Customer price", "remarks": "Remarks", "delivery": "Delivery"}

_poll_lock = asyncio.Lock()
_tasks: dict[str, asyncio.Task] = {}


# --- background loops ------------------------------------------------------------------

async def poll_inbox_once() -> dict:
    async with _poll_lock:
        enquiries, skipped = await asyncio.to_thread(inbox.fetch_unseen)
        ids = [await pipeline.ingest(raw) for raw in enquiries]
        if ids or skipped:
            db.log_event(None, "INBOX", f"Polled {get_settings().imap_user}: {len(ids)} new email(s), {skipped} own notification(s) skipped")
        return {"new_enquiry_ids": ids, "skipped_own_notifications": skipped}


async def _poll_loop(interval: int) -> None:
    last_error = None
    while True:
        try:
            await poll_inbox_once()
            last_error = None
        except Exception as exc:
            msg = f"Inbox poll failed: {type(exc).__name__}: {exc}"
            if msg != last_error:  # don't flood the audit log with the same failure every minute
                db.log_event(None, "INBOX", msg, "error")
                last_error = msg
        await asyncio.sleep(interval)


async def _retry_loop() -> None:
    while True:
        try:
            await pipeline.run_due_retries()
        except Exception:
            log.exception("Retry scheduler failed")
        await asyncio.sleep(10)


def _restart_poller() -> None:
    s = get_settings()
    if task := _tasks.pop("poll", None):
        task.cancel()
    if s.imap_enabled and s.imap_poll_seconds > 0:
        _tasks["poll"] = asyncio.create_task(_poll_loop(s.imap_poll_seconds))


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    s = get_settings()
    log.info("ERP=%s, AI=%s (%s), SMTP=%s, IMAP=%s, login=%s", s.erp_connector, s.ai_enabled, s.ai_provider,
             s.smtp_enabled, s.imap_enabled, auth.enabled())
    # Enquiries interrupted by a restart mid-run are re-queued rather than left in PROCESSING.
    db.execute("UPDATE enquiries SET status = 'RETRY_PENDING', next_retry_at = ? WHERE status IN ('PROCESSING', 'RECEIVED')",
               (db.now_iso(),))
    _restart_poller()
    _tasks["retry"] = asyncio.create_task(_retry_loop())
    yield
    for task in _tasks.values():
        task.cancel()


app = FastAPI(title="AI Quote Creation Agent", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

OPEN_PATHS = ("/login", "/api/login", "/static/login", "/favicon")


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if auth.enabled() and not path.startswith(OPEN_PATHS) and not auth.verify(request.cookies.get(auth.COOKIE)):
        if path.startswith("/api/"):
            return JSONResponse({"detail": "Login required"}, status_code=401)
        if path == "/":
            return FileResponse(STATIC_DIR / "login.html")
    return await call_next(request)


@app.get("/", include_in_schema=False)
def dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/login", include_in_schema=False)
def login_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "login.html")


@app.post("/api/login")
async def login(request: Request) -> Response:
    body = await request.json()
    if not auth.enabled():
        return JSONResponse({"ok": True})
    if not auth.check_password(str(body.get("username", "")), str(body.get("password", ""))):
        await asyncio.sleep(1)  # slow down guessing
        raise HTTPException(401, "Wrong username or password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(auth.COOKIE, auth.make_token(body["username"]), httponly=True, samesite="lax",
                    max_age=auth.SESSION_SECONDS, secure=request.url.scheme == "https")
    return resp


@app.post("/api/logout")
def logout() -> Response:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE)
    return resp


# --- filters ------------------------------------------------------------------------

def _utc(value: str) -> str:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, f"Bad datetime: {value}")
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _filters(q: str | None, start: str | None, end: str | None, alias: str = "e") -> tuple[str, list]:
    """WHERE fragment for search text + [start, end) datetime range (browser sends local-midnight ISO)."""
    clauses, params = [], []
    if start:
        clauses.append(f"{alias}.created_at >= ?")
        params.append(_utc(start))
    if end:
        clauses.append(f"{alias}.created_at < ?")
        params.append(_utc(end))
    if q and q.strip():
        like = f"%{q.strip()}%"
        cols = ["sender_email", "sender_name", "subject", "customer_name", "erp_customer_name", "reference",
                "erp_quote_number", "attachment_name", "error_code", "contact_phone"]
        clauses.append("(" + " OR ".join(f"{alias}.{c} LIKE ?" for c in cols)
                       + f" OR {alias}.id IN (SELECT enquiry_id FROM line_items WHERE sku LIKE ? OR name LIKE ? OR erp_item_name LIKE ?))")
        params += [like] * (len(cols) + 3)
    return (" AND ".join(clauses) or "1=1"), params


# --- read API ---------------------------------------------------------------------

@app.get("/api/status")
def status() -> dict:
    s = get_settings()
    erp = get_connector()
    return {
        "erp": {"key": erp.key, "name": erp.name, "quote_label": erp.quote_label, "is_mock": erp.is_mock,
                "locked_to": s.lock_erp_connector or None},
        "ai_enabled": s.ai_enabled, "ai_provider": s.ai_provider_label, "ai_model": s.active_ai_model,
        "smtp_enabled": s.smtp_enabled, "imap_enabled": s.imap_enabled, "imap_poll_seconds": s.imap_poll_seconds,
        "monitored_inbox": s.monitored_inbox, "sales_team_email": s.sales_team_email,
        "alert_recipients": s.alert_recipients, "unmatched_item_policy": s.unmatched_item_policy,
        "manual_minutes_per_enquiry": s.manual_minutes_per_enquiry, "manual_minutes_per_line": s.manual_minutes_per_line,
        "login_enabled": auth.enabled(), "user": s.admin_user if auth.enabled() else None,
        "readiness": readiness.config_checks(),
        "samples": [{"key": k, "label": v[0]} for k, v in SAMPLES.items()],
    }


ENQUIRY_LIST_SQL = """
SELECT e.id, e.created_at, e.source, e.sender_email, e.sender_name, e.subject, e.attachment_name, e.customer_name,
       e.erp_customer_name, e.reference, e.status, e.error_code, e.error_message, e.erp_connector, e.processing_ms,
       e.erp_quote_number, e.erp_quote_url, e.quote_total, e.currency, e.duplicate_of, e.retry_count, e.next_retry_at,
       (SELECT COUNT(*) FROM line_items l WHERE l.enquiry_id = e.id) AS line_count,
       (SELECT COUNT(*) FROM line_items l WHERE l.enquiry_id = e.id AND l.flags IS NOT NULL AND l.flags != '') AS review_count,
       (SELECT COUNT(*) FROM attachments a WHERE a.enquiry_id = e.id) AS attachment_count
FROM enquiries e"""
OPEN_EXCEPTION = "('EXCEPTION','RETRY_PENDING')"


@app.get("/api/enquiries")
def list_enquiries(status: str | None = None, q: str | None = None, start: str | None = None,
                   end: str | None = None, limit: int = 200) -> list[dict]:
    where, params = _filters(q, start, end)
    if status == "OTHER":
        where += " AND e.status IN ('DUPLICATE','IGNORED','DISMISSED','REJECTED')"
    elif status == "EXCEPTION":
        where += f" AND e.status IN {OPEN_EXCEPTION}"
    elif status:
        where += " AND e.status = ?"
        params.append(status)
    return db.fetch_all(f"{ENQUIRY_LIST_SQL} WHERE {where} ORDER BY e.id DESC LIMIT ?", (*params, min(limit, 500)))


@app.get("/api/metrics")
def metrics(q: str | None = None, start: str | None = None, end: str | None = None) -> dict:
    s = get_settings()
    where, params = _filters(q, start, end)
    scope = f"SELECT e.id FROM enquiries e WHERE {where}"
    rows = db.fetch_all(f"{ENQUIRY_LIST_SQL} WHERE {where}", tuple(params))

    by_status: dict[str, int] = {}
    for r in rows:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    drafted = [r for r in rows if r["erp_quote_number"]]

    methods = {r["m"] or "none": r["n"] for r in db.fetch_all(
        f"SELECT match_method AS m, COUNT(*) AS n FROM line_items WHERE enquiry_id IN ({scope}) "
        f"AND enquiry_id IN (SELECT id FROM enquiries WHERE erp_quote_id IS NOT NULL) GROUP BY match_method", tuple(params))}
    lines = {"exact": methods.get("sku", 0) + methods.get("name", 0), "ai": methods.get("ai", 0),
             "fuzzy": methods.get("fuzzy", 0), "none": methods.get("none", 0)}
    total_lines = sum(lines.values())
    flag_counts = {f: db.fetch_one(f"SELECT COUNT(*) AS n FROM line_items WHERE enquiry_id IN ({scope}) AND flags LIKE ?",
                                   (*params, f"%{f}%"))["n"] for f in ("price_missing", "unit_mismatch")}

    def distinct(sql: str) -> int:
        return db.fetch_one(f"SELECT COUNT(DISTINCT enquiry_id) AS n FROM {sql} AND enquiry_id IN ({scope})", tuple(params))["n"]

    timed = [r["processing_ms"] for r in rows if r["processing_ms"] is not None and r["status"] != "DUPLICATE"]
    effort_min = sum(s.manual_minutes_per_enquiry + s.manual_minutes_per_line * (r["line_count"] or 0) for r in drafted)

    local = lambda iso: datetime.fromisoformat(iso).astimezone().date()  # noqa: E731
    last_day = (datetime.fromisoformat(_utc(end)).astimezone() - timedelta(seconds=1)).date() if end else date.today()
    first_day = datetime.fromisoformat(_utc(start)).astimezone().date() if start else last_day - timedelta(days=13)
    if (last_day - first_day).days > 60:
        first_day = last_day - timedelta(days=60)
    days = {first_day + timedelta(days=i): {"clean": 0, "review": 0, "exception": 0, "other": 0}
            for i in range((last_day - first_day).days + 1)}
    bucket = {"DRAFT_CREATED": "clean", "APPROVED": "clean", "NEEDS_REVIEW": "review", "EXCEPTION": "exception",
              "RETRY_PENDING": "exception"}
    for r in rows:
        d = local(r["created_at"])
        if d in days:
            days[d][bucket.get(r["status"], "other")] += 1

    open_ex = [r for r in rows if r["status"] in ("EXCEPTION", "RETRY_PENDING")]
    by_code: dict[str, int] = {}
    for r in open_ex:
        by_code[r["error_code"] or "UNKNOWN"] = by_code.get(r["error_code"] or "UNKNOWN", 0) + 1

    return {
        "total": len(rows),
        "by_status": by_status,
        "drafts": len(drafted),
        "approved": by_status.get("APPROVED", 0),
        "quoted_value": round(sum(r["quote_total"] or 0 for r in drafted), 2),
        "currency": next((r["currency"] for r in drafted if r["currency"]), None),
        "lines": lines,
        "total_lines": total_lines,
        "flag_counts": flag_counts,
        "auto_match_rate": round((total_lines - lines["none"]) / total_lines, 4) if total_lines else None,
        "avg_processing_s": round(sum(timed) / len(timed) / 1000, 2) if timed else None,
        "effort_saved_hours": round(effort_min / 60, 1),
        "open_exceptions": len(open_ex),
        "exceptions_by_code": by_code,
        "review_enquiries": by_status.get("NEEDS_REVIEW", 0),
        "funnel": {
            "received": len(rows),
            "read": sum(1 for r in rows if r["line_count"]),
            "validated": distinct("audit_events WHERE stage = 'VALIDATE' AND level = 'success'"),
            "customer": distinct("audit_events WHERE stage = 'MAP_CUSTOMER' AND level = 'success'"),
            "drafted": len(drafted),
            "notified": distinct("notifications WHERE kind IN ('internal', 'draft_created')"),
        },
        "daily": [{"date": d.isoformat(), **v} for d, v in days.items()],
    }


@app.get("/api/exceptions")
def exception_queue(q: str | None = None, start: str | None = None, end: str | None = None) -> dict:
    where, params = _filters(q, start, end)
    erp = get_connector().name
    open_rows = db.fetch_all(f"{ENQUIRY_LIST_SQL} WHERE {where} AND e.status IN {OPEN_EXCEPTION} ORDER BY e.id DESC", tuple(params))
    for r in open_rows:
        r["hint"] = (EXCEPTION_HINTS.get(r["error_code"] or "", "Review the audit trail, fix the cause, then Reprocess.")
                     .format(erp=erp))
        if r["status"] == "RETRY_PENDING":
            r["hint"] = f"Temporary problem — the agent retries automatically ({r['retry_count']} of {get_settings().retry_attempts})."
    review = db.fetch_all(f"{ENQUIRY_LIST_SQL} WHERE {where} AND e.status = 'NEEDS_REVIEW' ORDER BY e.id DESC", tuple(params))
    return {"open": open_rows, "review": review}


@app.get("/api/enquiries/{eid}")
def get_enquiry(eid: int) -> dict:
    detail = db.enquiry_detail(eid)
    if not detail:
        raise HTTPException(404, "Enquiry not found")
    return detail


@app.get("/api/enquiries/{eid}/source")
def enquiry_source(eid: int) -> dict:
    """What the agent read: the mapped spreadsheet columns per line, or the email body / document."""
    row = db.fetch_one("SELECT attachment_name, attachment_blob, body_text, source_sheet, source_header_row, "
                       "source_mapping, mapped_by FROM enquiries WHERE id = ?", (eid,))
    if not row:
        raise HTTPException(404, "Enquiry not found")
    files = [a for a in db.fetch_all("SELECT name, blob FROM attachments WHERE enquiry_id = ? ORDER BY id", (eid,))
             if att.kind(a["name"]) == "sheet"]
    sheet_file = files[0] if files else ({"name": row["attachment_name"], "blob": row["attachment_blob"]}
                                         if row["attachment_blob"] and att.kind(row["attachment_name"] or "") == "sheet" else None)
    if not sheet_file or row["source_sheet"] is None:
        return {"kind": "email", "mapped_by": row["mapped_by"], "body": row["body_text"]}
    try:
        sheets = load_sheets(sheet_file["blob"], sheet_file["name"] or "")
    except ParseError as exc:
        return {"kind": "error", "message": str(exc)}
    rows = sheets.get(row["source_sheet"]) or next(iter(sheets.values()))
    header_idx = row["source_header_row"]
    mapping: dict[str, int] = json.loads(row["source_mapping"] or "{}")
    header = rows[header_idx] if 0 <= header_idx < len(rows) else []
    columns = [{"index": idx, "field": f, "field_label": FIELD_LABELS.get(f, f),
                "header": (clean_text(header[idx]) if idx < len(header) else None) or f"Column {idx + 1}"}
               for f, idx in sorted(mapping.items(), key=lambda kv: kv[1])]
    cell = lambda r, i: ((clean_text(rows[r][i]) or "") if r < len(rows) and i < len(rows[r]) else "")[:160]  # noqa: E731
    line_rows = db.fetch_all("SELECT source_row FROM line_items WHERE enquiry_id = ? AND source_row IS NOT NULL", (eid,))
    return {
        "kind": "sheet", "file": sheet_file["name"], "sheet": row["source_sheet"], "header_row": header_idx,
        "mapped_by": row["mapped_by"], "columns": columns,
        "cells": {str(lr["source_row"]): [cell(lr["source_row"], c["index"]) for c in columns] for lr in line_rows},
        "preview": [[(clean_text(c) or "")[:60] for c in r] for r in rows[: max(header_idx, 0) + 1 + 40]],
    }


@app.get("/api/enquiries/{eid}/attachment")
def download_attachment(eid: int, file_id: int | None = None) -> Response:
    if file_id:
        row = db.fetch_one("SELECT name, blob FROM attachments WHERE id = ? AND enquiry_id = ?", (file_id, eid))
    else:
        row = db.fetch_one("SELECT name, blob FROM attachments WHERE enquiry_id = ? ORDER BY id", (eid,)) or \
              db.fetch_one("SELECT attachment_name AS name, attachment_blob AS blob FROM enquiries WHERE id = ?", (eid,))
    if not row or not row["blob"]:
        raise HTTPException(404, "No attachment")
    return Response(row["blob"], media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{row["name"]}"'})


@app.get("/api/enquiries/{eid}/quote-document")
def quote_document(eid: int, fmt: str = "pdf") -> FileResponse:
    """The PDF / Excel quotation written by document-producing connectors (standalone, webhook)."""
    row = db.fetch_one("SELECT erp_quote_number FROM enquiries WHERE id = ?", (eid,))
    if not row or not row["erp_quote_number"] or fmt not in ("pdf", "xlsx"):
        raise HTTPException(404, "No quotation document")
    path = get_settings().standalone_dir / "quotes" / f"{row['erp_quote_number']}.{fmt}"
    if not path.exists():
        raise HTTPException(404, "This connector doesn't produce documents")
    return FileResponse(path, filename=path.name)


@app.get("/api/events")
def events(after_id: int = 0, limit: int = 100) -> list[dict]:
    return db.fetch_all(
        "SELECT * FROM (SELECT * FROM audit_events WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id",
        (after_id, min(limit, 500)),
    )


# --- actions --------------------------------------------------------------------------

async def _read_limited(upload: UploadFile) -> bytes:
    data = await upload.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File larger than 15 MB")
    return data


def _summary(eid: int) -> dict:
    return db.fetch_one("SELECT id, status, error_code FROM enquiries WHERE id = ?", (eid,))


@app.post("/api/enquiries")
async def submit_enquiry(
    sender_email: str = Form(""),
    sender_name: str = Form(""),
    subject: str = Form(""),
    body: str = Form(""),
    attachment: list[UploadFile] | None = File(None),
    eml: UploadFile | None = File(None),
) -> dict:
    """Simulate an inbound email: a raw .eml file, or sender/subject/body + attachments (Excel, PDF, image, Word).
    Processing runs in the background; poll GET /api/enquiries/{id} to watch the stages."""
    if eml and eml.filename:
        raw = parse_eml(await _read_limited(eml), source="upload")
    else:
        if not sender_email:
            raise HTTPException(422, "sender_email is required (or upload an .eml file)")
        files = []
        for up in attachment or []:
            if not up.filename:
                continue
            if not att.kind(up.filename):
                raise HTTPException(422, f"{up.filename}: use Excel/CSV, PDF, image (PNG/JPG) or Word (.docx)")
            files.append(AttachmentFile(name=up.filename, content_type=up.content_type or att.mime(up.filename),
                                        data=await _read_limited(up)))
        primary = next((f for f in files if att.kind(f.name) == "sheet"), files[0] if files else None)
        raw = RawEnquiry(source="upload", sender_email=sender_email.strip().lower(), sender_name=sender_name or None,
                         subject=subject, body_text=body, received_at=datetime.now(),
                         attachment_name=primary.name if primary else None,
                         attachment_bytes=primary.data if primary else None, attachments=files)
    return _summary(await pipeline.ingest(raw, background=True))


@app.post("/api/samples/{key}")
async def run_sample(key: str) -> dict:
    if key not in SAMPLES:
        raise HTTPException(404, "Unknown sample")
    raw = parse_eml((SAMPLES_DIR / SAMPLES[key][1]).read_bytes(), source="sample")
    raw.received_at = datetime.now()
    return _summary(await pipeline.ingest(raw, background=True))


@app.post("/api/enquiries/{eid}/reprocess")
async def reprocess(eid: int) -> dict:
    row = db.fetch_one("SELECT status FROM enquiries WHERE id = ?", (eid,))
    if not row:
        raise HTTPException(404, "Enquiry not found")
    if row["status"] not in ("EXCEPTION", "RETRY_PENDING", "IGNORED", "DISMISSED"):
        raise HTTPException(409, f"Only open exceptions or ignored enquiries can be reprocessed (this one is {row['status']})")
    db.log_event(eid, "REPROCESS", "Reprocess requested from dashboard")
    db.update_enquiry(eid, status="PROCESSING", error_code=None, error_message=None, retry_count=0, next_retry_at=None)
    pipeline.run_in_background(pipeline.process(eid))
    return _summary(eid)


def _set_status(eid: int, allowed: tuple[str, ...], new: str, stage: str, message: str, level: str = "info") -> dict:
    row = db.fetch_one("SELECT status FROM enquiries WHERE id = ?", (eid,))
    if not row:
        raise HTTPException(404, "Enquiry not found")
    if row["status"] not in allowed:
        raise HTTPException(409, f"Not possible while the enquiry is {row['status']}")
    db.update_enquiry(eid, status=new)
    db.log_event(eid, stage, message, level)
    return _summary(eid)


@app.post("/api/enquiries/{eid}/dismiss")
def dismiss(eid: int) -> dict:
    return _set_status(eid, ("EXCEPTION", "RETRY_PENDING"), "DISMISSED", "DISMISS", "Exception dismissed from the queue", "warn")


@app.post("/api/enquiries/{eid}/approve")
async def approve(eid: int, request: Request) -> dict:
    user = auth.verify(request.cookies.get(auth.COOKIE)) or "dashboard user"
    erp = get_connector().name
    return _set_status(eid, ("DRAFT_CREATED", "NEEDS_REVIEW"), "APPROVED", "APPROVE",
                       f"Draft approved by {user}. It is still not sent — send it to the customer from {erp}.", "success")


@app.post("/api/enquiries/{eid}/reject")
async def reject(eid: int, request: Request) -> dict:
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    user = auth.verify(request.cookies.get(auth.COOKIE)) or "dashboard user"
    reason = str(body.get("reason") or "no reason given")[:300]
    return _set_status(eid, ("DRAFT_CREATED", "NEEDS_REVIEW", "APPROVED"), "REJECTED", "REJECT",
                       f"Draft rejected by {user}: {reason}", "warn")


@app.post("/api/inbox/poll")
async def poll_inbox() -> dict:
    if not get_settings().imap_enabled:
        raise HTTPException(400, "The inbox isn't connected — add the mailbox details in Setup → Email")
    try:
        return await poll_inbox_once()
    except Exception as exc:
        db.log_event(None, "INBOX", f"Manual poll failed: {type(exc).__name__}: {exc}", "error")
        raise HTTPException(502, f"Inbox poll failed: {exc}")


@app.post("/api/readiness/test")
async def test_connections() -> dict:
    return {"config": readiness.config_checks(), "live": await readiness.live_checks()}


# --- setup ------------------------------------------------------------------------------

@app.get("/api/setup")
def get_setup() -> dict:
    return setup.view()


@app.post("/api/setup")
async def save_setup(request: Request) -> dict:
    body = await request.json()
    try:
        changed = setup.apply(body.get("values") or {})
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    _restart_poller()
    if changed:
        db.log_event(None, "SETUP", "Settings changed: " + ", ".join(k for k in changed if "PASSWORD" not in k and "SECRET" not in k
                                                                     and "KEY" not in k and "TOKEN" not in k)
                     + (" (+ credentials)" if any(t in k for k in changed for t in ("PASSWORD", "SECRET", "KEY", "TOKEN")) else ""))
    resp = JSONResponse({"changed": changed, "readiness": readiness.config_checks(), "setup": setup.view()})
    if "ADMIN_PASSWORD" in changed or "ADMIN_USER" in changed:  # keep the person who set the password logged in
        resp.set_cookie(auth.COOKIE, auth.make_token(get_settings().admin_user), httponly=True, samesite="lax",
                        max_age=auth.SESSION_SECONDS, secure=request.url.scheme == "https")
    return resp


@app.post("/api/setup/zoho/connect")
async def zoho_connect(request: Request) -> dict:
    body = await request.json()
    try:
        if body.get("pending"):
            result = setup.zoho_choose(str(body["pending"]), str(body.get("organization_id", "")))
        else:
            result = await setup.zoho_connect(body.get("dc", "in"), body.get("client_id", ""),
                                              body.get("client_secret", ""), body.get("code", ""))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if result.get("connected"):
        db.log_event(None, "SETUP", f"Zoho Books connected: {result['organization']['name']} ({result['organization']['id']})", "success")
    return result


@app.post("/api/setup/zoho/demo-data")
async def zoho_demo_data(request: Request) -> dict:
    """Preview (apply=false) or create (apply=true) the demo customer and items in the connected Zoho Books."""
    from . import zoho_demo
    from .connectors.zoho_books import ZohoBooksConnector
    body = await request.json()
    zoho = ZohoBooksConnector()
    if not zoho.readiness()[0]:
        raise HTTPException(400, "Connect Zoho Books first")
    gst = {k: (str(body.get(k) or "").strip() or None) for k in ("gst_treatment", "place_of_supply", "hsn")}
    try:
        todo, notes = await zoho_demo.plan(zoho, **gst)
        if not body.get("apply"):
            return {"todo": [t["label"] for t in todo], "notes": notes}
        results = await zoho_demo.apply(zoho, todo)
    except ConnectorError as exc:
        raise HTTPException(502, f"Zoho Books: {exc}")
    created = sum(r["ok"] for r in results)
    db.log_event(None, "SETUP", f"Demo data loaded into Zoho Books: {created} of {len(results)} record(s) created",
                 "success" if created == len(results) else "warn")
    setup.reload()
    return {"results": results, "notes": notes}


@app.post("/api/setup/price-list")
async def upload_price_list(file: UploadFile = File(...)) -> dict:
    name = (file.filename or "").lower()
    ext = next((e for e in (".xlsx", ".xls", ".csv") if name.endswith(e)), None)
    if not ext:
        raise HTTPException(422, "Upload the price list as .xlsx, .xls or .csv")
    data = await _read_limited(file)
    target_dir = get_settings().standalone_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    tmp = target_dir / f".upload{ext}"
    tmp.write_bytes(data)
    from .connectors.standalone import StandaloneConnector
    probe = StandaloneConnector()
    for old in target_dir.glob("price_list.*"):
        old.rename(old.with_suffix(old.suffix + ".bak"))
    final = target_dir / f"price_list{ext}"
    tmp.rename(final)
    try:
        items = await probe.get_items()
    except Exception as exc:
        final.unlink(missing_ok=True)
        for bak in target_dir.glob("price_list.*.bak"):
            bak.rename(bak.with_suffix(""))
        raise HTTPException(422, f"Couldn't read that price list: {exc}")
    for bak in target_dir.glob("price_list.*.bak"):
        bak.unlink()
    setup.reload()
    db.log_event(None, "SETUP", f"Price list uploaded: {file.filename} ({len(items)} items)", "success")
    return {"items": len(items), "without_price": sum(1 for i in items if not i.rate)}


@app.post("/api/admin/reset")
def reset_demo() -> dict:
    """Clear all enquiries and logs (demo convenience)."""
    for table in ("line_items", "attachments", "exceptions", "audit_events", "notifications", "dedup_hashes", "enquiries"):
        db.execute(f"DELETE FROM {table}")
    db.log_event(None, "ADMIN", "Demo data reset")
    return {"ok": True}
