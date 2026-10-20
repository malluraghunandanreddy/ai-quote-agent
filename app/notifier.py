"""Notification emails (requirements section 3) plus failure / customer-review alerts.

  A  info_request        → Sales         "Additional Information Required – Customer Quotation"
  B  unmatched_products  → stakeholders  "New/Unmatched Products Identified – Quote Enquiry"
  C  draft_created       → Sales         "Draft Quotation Created – <Customer Name>"
     customer_review     → Sales         "Customer Review Required – Quote Enquiry"
     failure             → stakeholders  "Quote Agent Processing Failure – <code>"

Every message carries X-Quote-Agent + Auto-Submitted headers, and the subjects above are recognised by the
inbox reader, so the agent never re-ingests its own mail (the inbox and Sales can be the same mailbox).
"""
from __future__ import annotations

import smtplib
import ssl
import time
from email.message import EmailMessage
from html import escape
from pathlib import Path
from typing import Any

from . import db
from .config import get_settings
from .connectors import get_connector
from .email_parser import AGENT_HEADER

TD = "padding:6px 10px;border-bottom:1px solid #e5e7eb;font:13px Arial,sans-serif;vertical-align:top"
TH = TD + ";background:#f3f4f6;text-align:left;font-weight:bold"


def _unique(addresses: list[str]) -> list[str]:
    return list(dict.fromkeys(a.strip().lower() for a in addresses if a and a.strip()))


def _smtp_send(msg: EmailMessage) -> None:
    s = get_settings()
    if s.smtp_starttls:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(s.smtp_user, s.smtp_password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=20, context=ssl.create_default_context()) as smtp:
            smtp.login(s.smtp_user, s.smtp_password)
            smtp.send_message(msg)


def send(kind: str, enquiry_id: int | None, recipients: list[str], subject: str, html: str, text: str,
         attachments: list[str] | None = None) -> str:
    s = get_settings()
    to = _unique(recipients)
    status, error = "logged", None
    files = [Path(p) for p in attachments or [] if Path(p).exists()]
    if s.smtp_enabled and to:
        msg = EmailMessage()
        msg["From"] = s.smtp_from
        msg["To"] = ", ".join(to)
        msg["Subject"] = subject
        msg[AGENT_HEADER] = kind
        msg["Auto-Submitted"] = "auto-generated"
        msg.set_content(text)
        msg.add_alternative(html, subtype="html")
        for f in files:
            maintype, subtype = ("application", "pdf") if f.suffix == ".pdf" else \
                ("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            msg.add_attachment(f.read_bytes(), maintype=maintype, subtype=subtype, filename=f.name)
        for attempt in range(1, s.smtp_retry_attempts + 1):
            try:
                _smtp_send(msg)
                status, error = "sent", None
                break
            except smtplib.SMTPAuthenticationError as exc:  # wrong password: retrying won't help
                status, error = "failed", f"SMTP login rejected: {exc.smtp_error.decode(errors='replace') if isinstance(exc.smtp_error, bytes) else exc}"
                break
            except Exception as exc:  # delivery problems must never break the pipeline
                status, error = "failed", f"{type(exc).__name__}: {exc} (attempt {attempt} of {s.smtp_retry_attempts})"
                if attempt < s.smtp_retry_attempts:
                    time.sleep(2 * attempt)
    elif not s.smtp_enabled:
        error = "SMTP not configured — logged to dashboard only"

    if files:
        error = (error + " · " if error else "") + "attachments: " + ", ".join(f.name for f in files)
    db.insert("notifications", enquiry_id=enquiry_id, created_at=db.now_iso(), kind=kind,
              recipients=", ".join(to), subject=subject, body_html=html, status=status, error=error)
    level = {"sent": "success", "logged": "warn", "failed": "error"}[status]
    db.log_event(enquiry_id, "NOTIFY", f"{kind.replace('_', ' ')} email to {', '.join(to)} — {status}"
                                       + (f" ({error})" if error and status != "sent" else ""), level)
    return status


# --- building blocks -------------------------------------------------------------------

def _money(v: float | None, cur: str | None = None) -> str:
    return "" if v is None else f"{cur + ' ' if cur else ''}{v:,.2f}"


def _kv(rows: list[tuple[str, Any]]) -> str:
    body = "".join(f"<tr><td style='{TD}'><b>{escape(k)}</b></td><td style='{TD}'>{v}</td></tr>"
                   for k, v in rows if v not in (None, ""))
    return f"<table style='border-collapse:collapse;margin:8px 0'>{body}</table>"


def _grid(headers: list[str], rows: list[list[str]], right: set[int] = frozenset()) -> str:
    head = "".join(f"<th style='{TH}{';text-align:right' if i in right else ''}'>{escape(h)}</th>" for i, h in enumerate(headers))
    body = "".join("<tr>" + "".join(f"<td style='{TD}{';text-align:right' if i in right else ''}'>{c}</td>"
                                    for i, c in enumerate(r)) + "</tr>" for r in rows)
    return f"<table style='border-collapse:collapse;margin:8px 0'><tr>{head}</tr>{body}</table>"


def _customer(e: dict) -> str:
    return e.get("erp_customer_name") or e.get("customer_name") or e.get("sender_name") or e.get("sender_email") or "Customer"


def _reference(e: dict) -> str:
    return e.get("reference") or f"Enquiry #{e['id']}"


def _original_email(e: dict) -> str:
    s = get_settings()
    link = f"{s.dashboard_url}/#enquiry={e['id']}"
    return ("<p style='margin-top:16px'><b>Original email</b></p>" + _kv([
        ("From", escape(f"{e.get('sender_name') or ''} <{e.get('sender_email') or ''}>".strip())),
        ("Subject", escape(e.get("subject") or "")),
        ("Received", escape((e.get("received_at") or "").replace("T", " ")[:16])),
        ("Attachment", escape(e.get("attachment_name") or "")),
        ("Message-ID", escape(e.get("message_id") or "")),
    ]) + f"<p><a href='{escape(link)}'>Open enquiry #{e['id']} in the Quote Agent dashboard</a></p>")


def _wrap(inner: str) -> str:
    return f"<div style='font:14px Arial,sans-serif;color:#111;max-width:760px'>{inner}" \
           f"<p style='color:#6b7280;font-size:12px;margin-top:20px'>AI Quote Creation Agent · automated message</p></div>"


# --- A. additional information required → Sales ----------------------------------------------

def request_additional_info(enquiry: dict, missing: list[str]) -> str:
    s = get_settings()
    items = "".join(f"<li>{escape(m)}</li>" for m in missing)
    html = _wrap(f"""<p>A customer enquiry can't be quoted yet because required information is missing.
Please contact the customer for the details below. When they reply, their new email is processed automatically.</p>
{_kv([("Customer", escape(_customer(enquiry))), ("Customer email", escape(enquiry.get('sender_email') or '')),
      ("Enquiry reference", escape(_reference(enquiry)))])}
<p><b>Missing or invalid information</b></p><ul>{items}</ul>
{_original_email(enquiry)}""")
    text = (f"Additional information required for {_customer(enquiry)} ({_reference(enquiry)}): "
            + "; ".join(missing) + f". Original email: {enquiry.get('subject')} from {enquiry.get('sender_email')}.")
    return send("info_request", enquiry["id"], [s.sales_team_email], "Additional Information Required – Customer Quotation", html, text)


# --- B. new / unmatched products → stakeholders -----------------------------------------------

def unmatched_products(enquiry: dict, rows: list[dict]) -> str:
    s = get_settings()
    erp = get_connector()
    grid = _grid(["#", "Product name", "SKU / material code", "Quantity", "Reason"], [
        [str(r["line_no"]), escape(r.get("name") or ""), escape(r.get("sku") or "—"),
         escape(f"{r.get('quantity') or 0:g} {r.get('unit') or ''}".strip()), escape(r.get("review_note") or "Not found")]
        for r in rows], right={3})
    draft = enquiry.get("erp_quote_number")
    html = _wrap(f"""<p>{len(rows)} product line(s) in a customer enquiry could not be matched with certainty to the
{escape(erp.name)} product master. Prices were <b>not</b> assumed.</p>
{_kv([("Customer", escape(_customer(enquiry))), ("Enquiry reference", escape(_reference(enquiry))),
      ("Draft quotation", escape(f"{draft} (draft — not sent)") if draft else "Not created — products must be resolved first")])}
{grid}
<p>Please add the new products (or their prices) in {escape(erp.name)}, or confirm the suggested matches, so Sales can finalise the quotation.</p>
{_original_email(enquiry)}""")
    text = (f"{len(rows)} new/unmatched product(s) for {_customer(enquiry)} ({_reference(enquiry)}): "
            + "; ".join(f"{r.get('sku') or r.get('name')} x{r.get('quantity') or 0:g} — {r.get('review_note')}" for r in rows))
    return send("unmatched_products", enquiry["id"], s.alert_recipients, "New/Unmatched Products Identified – Quote Enquiry", html, text)


# --- C. draft quotation created → Sales ------------------------------------------------------

def draft_created(enquiry: dict, rows: list[dict], attachments: list[str] | None = None) -> str:
    s = get_settings()
    erp = get_connector()
    cur = enquiry.get("currency")
    flagged = [r for r in rows if r.get("flags")]
    items = _grid(["#", "Customer code", "Item", "Qty", "Rate", "Amount"], [
        [str(r["line_no"]), escape(r.get("sku") or ""),
         escape(r.get("erp_item_name") or r.get("name") or "")
         + (f"<br><span style='color:#b45309'>⚠ {escape(r['review_note'])}</span>" if r.get("flags") else ""),
         escape(f"{r.get('quantity') or 0:g} {r.get('unit') or ''}".strip()),
         _money(r.get("rate")) if r.get("rate") else "TBC", _money(r.get("amount")) if r.get("rate") else "TBC"]
        for r in rows], right={3, 4, 5})
    status_line = (f"<span style='color:#b45309'><b>Needs review</b> — {len(flagged)} line(s) flagged (see ⚠ below)</span>"
                   if flagged else "<span style='color:#047857'><b>Ready for review</b> — all lines matched with prices</span>")
    link = enquiry.get("erp_quote_url")
    where = (f"<p><a href='{escape(link)}'>Review the quotation in {escape(erp.name)}</a></p>" if link else
             "<p>The draft quotation is attached as PDF and Excel.</p>" if attachments else
             f"<p><i>{escape(erp.name)} — no online link for this draft.</i></p>")
    html = _wrap(f"""<p>A <b>draft quotation</b> was created from a customer enquiry. It has <b>not</b> been sent to the customer.</p>
{_kv([("Quotation number", escape(f"{enquiry.get('erp_quote_number')} ({enquiry.get('erp_quote_status') or 'draft'})")),
      ("Customer", escape(_customer(enquiry))), ("Customer email", escape(enquiry.get('sender_email') or '')),
      ("Contact", escape(" · ".join(x for x in (enquiry.get('contact_name'), enquiry.get('contact_phone')) if x))),
      ("Delivery address", escape(enquiry.get('delivery_address') or '')),
      ("Delivery terms", escape(enquiry.get('delivery_terms') or '')),
      ("Customer reference", escape(_reference(enquiry))), ("Required by", escape(enquiry.get('required_by') or '')),
      ("Total amount", escape(_money(enquiry.get('quote_total'), cur))), ("Processing status", status_line)])}
<p><b>Item summary ({len(rows)} lines)</b></p>{items}
{where}
{_original_email(enquiry)}""")
    text = (f"Draft quotation {enquiry.get('erp_quote_number')} created for {_customer(enquiry)} (not sent to customer). "
            f"Total {_money(enquiry.get('quote_total'), cur)}. {len(rows)} lines, {len(flagged)} need review. {link or ''}")
    return send("draft_created", enquiry["id"], [s.sales_team_email], f"Draft Quotation Created – {_customer(enquiry)}",
                html, text, attachments)


# --- customer not found → Sales --------------------------------------------------------------

def customer_review(enquiry: dict, message: str) -> str:
    s = get_settings()
    erp = get_connector()
    html = _wrap(f"""<p>A quotation request came from a sender who doesn't match any customer in {escape(erp.name)}.</p>
{_kv([("Sender", escape(enquiry.get('sender_email') or '')), ("Name in the email", escape(enquiry.get('customer_name') or '—')),
      ("Contact", escape(" · ".join(x for x in (enquiry.get('contact_name'), enquiry.get('contact_phone')) if x))),
      ("Enquiry reference", escape(_reference(enquiry))), ("Details", escape(message))])}
<p>Please create the customer in {escape(erp.name)} with this email address (or add the email to the existing customer),
then press <b>Reprocess</b> on the dashboard.</p>
{_original_email(enquiry)}""")
    return send("customer_review", enquiry["id"], [s.sales_team_email], "Customer Review Required – Quote Enquiry", html,
                f"Customer not found for {enquiry.get('sender_email')} ({_reference(enquiry)}): {message}")


# --- system failure → team -------------------------------------------------------------------

def processing_failure(enquiry: dict, code: str, message: str, attempts: int = 0) -> str:
    s = get_settings()
    html = _wrap(f"""<p style='color:#b91c1c'><b>A quote request could not be processed.</b></p>
{_kv([("Error", escape(code)), ("Details", escape(message)),
      ("Automatic retries", escape(f"{attempts} attempted" if attempts else "none — not a temporary error")),
      ("Customer", escape(_customer(enquiry))), ("Enquiry reference", escape(_reference(enquiry)))])}
<p>Fix the cause (connection, credentials or the data the system rejected) and press <b>Reprocess</b> on the dashboard.</p>
{_original_email(enquiry)}""")
    return send("failure", enquiry["id"], s.alert_recipients, f"Quote Agent Processing Failure – {code}", html,
                f"Quote request #{enquiry['id']} failed: {code} — {message}")
