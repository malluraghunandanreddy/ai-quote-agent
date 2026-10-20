"""Setup page backend: which settings exist per connector / AI provider, current values, and live apply.

Only keys listed here can be changed from the dashboard. Secret values are never sent back to the browser;
an empty secret field means "keep the current value".
"""
from __future__ import annotations

import os
import secrets
import time

import httpx

from . import ai, connectors
from .config import get_settings
from .envfile import update_env

ZOHO_SCOPES = ("ZohoBooks.estimates.CREATE,ZohoBooks.estimates.READ,ZohoBooks.contacts.CREATE,"
               "ZohoBooks.contacts.READ,ZohoBooks.settings.CREATE,ZohoBooks.settings.READ")

# (ENV_KEY, label, type, help) — type: text | secret | number | email | bool | select:<a>,<b>
BUSINESS = [
    ("BUSINESS_NAME", "Business name (printed on quotations)", "text", ""),
    ("BUSINESS_ADDRESS", "Business address", "text", ""),
    ("BUSINESS_GSTIN", "GSTIN", "text", "Optional"),
    ("BUSINESS_PHONE", "Phone", "text", ""),
    ("STANDALONE_TAX_PERCENT", "Tax % added to quotations", "number", "e.g. 18 for 18% GST; 0 for none"),
    ("QUOTE_TERMS", "Terms printed on quotations", "text", ""),
]
ERP_FIELDS: dict[str, list[tuple[str, str, str, str]]] = {
    "mock": [],
    "zoho_books": [
        ("ZOHO_DC", "Zoho data centre", "select:in,com,eu,com.au,jp,ca,sa", "in = zoho.in accounts"),
        ("ZOHO_CLIENT_ID", "Client ID", "text", "api-console.zoho.in → Self Client"),
        ("ZOHO_CLIENT_SECRET", "Client secret", "secret", ""),
        ("ZOHO_REFRESH_TOKEN", "Refresh token", "secret", "Created by scripts/zoho_oauth_helper.py"),
        ("ZOHO_ORGANIZATION_ID", "Organization ID", "text", ""),
    ],
    "standalone": BUSINESS,
    "webhook": [("WEBHOOK_URL", "Webhook URL", "text", "Zapier / Make / n8n / your system"),
                ("WEBHOOK_SECRET", "Signing secret", "secret", "Optional — verifies the POST came from this agent"), *BUSINESS],
}
ERP_INFO = {
    "mock": "Demo data for trying the agent. No real quotations.",
    "zoho_books": "Draft estimates are created in your Zoho Books organization.",
    "standalone": "No accounting software needed: keep a price list in Excel; each quotation is emailed to you as PDF + Excel.",
    "webhook": "Like the no-software option, plus every draft is sent as JSON to Zapier, Make, n8n or your own system.",
}
AI_FIELDS = {
    "gemini": [("GEMINI_API_KEY", "Gemini API key", "secret", "aistudio.google.com → Get API key"),
               ("GEMINI_MODEL", "Model", "text", "")],
    "anthropic": [("ANTHROPIC_API_KEY", "Anthropic API key", "secret", "platform.claude.com → API Keys"),
                  ("AI_MODEL", "Model", "text", "")],
    "openai": [("OPENAI_BASE_URL", "API base URL", "text", "OpenAI, Azure, Groq, DeepSeek, Ollama (http://localhost:11434/v1) …"),
               ("OPENAI_API_KEY", "API key", "secret", "Leave empty for local servers"),
               ("OPENAI_MODEL", "Model", "text", "")],
}
AI_INFO = {"gemini": "Google Gemini", "anthropic": "Anthropic Claude", "openai": "Any OpenAI-compatible API"}
MAIL_FIELDS = [
    ("SALES_TEAM_EMAIL", "Sales email (gets draft & info-request emails)", "email", ""),
    ("ALERT_RECIPIENTS", "Stakeholders for product / failure alerts", "text", "Comma-separated"),
    ("MONITORED_INBOX", "Inbox the agent watches", "email", ""),
    ("IMAP_HOST", "IMAP server", "text", "Zoho: imappro.zoho.in · Gmail: imap.gmail.com"),
    ("IMAP_PORT", "IMAP port", "number", "993"),
    ("IMAP_USER", "IMAP username", "text", "Usually the mailbox address"),
    ("IMAP_PASSWORD", "Mailbox app password", "secret", "Used for both reading and sending"),
    ("SMTP_HOST", "SMTP server", "text", "Zoho: smtppro.zoho.in · Gmail: smtp.gmail.com"),
    ("SMTP_PORT", "SMTP port", "number", "465 (SSL) or 587 (STARTTLS)"),
    ("SMTP_USER", "SMTP username", "text", ""),
    ("SMTP_FROM", "Send emails from", "email", ""),
    ("SMTP_STARTTLS", "Use STARTTLS (port 587)", "bool", ""),
]
RULE_FIELDS = [
    ("UNMATCHED_ITEM_POLICY", "Products not in the master", "select:free_text,exception",
     "free_text = add to the draft for review · exception = stop and alert"),
    ("REQUIRED_ENQUIRY_FIELDS", "Extra mandatory fields", "text",
     "Comma-separated: customer_name, contact_phone, delivery_address, delivery_terms, reference, required_by"),
    ("ESTIMATE_VALIDITY_DAYS", "Quotation validity (days)", "number", ""),
    ("AI_MATCH_MIN_CONFIDENCE", "Minimum AI match confidence (0–1)", "number", ""),
]
SECURITY_FIELDS = [("ADMIN_USER", "Admin username", "text", ""),
                   ("ADMIN_PASSWORD", "Admin password", "secret", "Required before others can reach the dashboard")]
SELECTORS = {"ERP_CONNECTOR", "AI_PROVIDER"}


def _all_fields() -> dict[str, tuple]:
    fields = {}
    for group in [*ERP_FIELDS.values(), *AI_FIELDS.values(), MAIL_FIELDS, RULE_FIELDS, SECURITY_FIELDS]:
        for f in group:
            fields[f[0]] = f
    return fields


def _describe(group: list[tuple]) -> list[dict]:
    out = []
    for key, label, kind, help_ in group:
        raw = os.getenv(key, "")
        item = {"key": key, "label": label, "type": kind, "help": help_}
        if kind == "secret":
            item["is_set"] = bool(raw)
        else:
            item["value"] = raw
        out.append(item)
    return out


def view() -> dict:
    s = get_settings()
    lock_erp, lock_ai = s.lock_erp_connector, s.lock_ai_provider
    erp_options = [o for o in connectors.options() if not lock_erp or o["key"] == lock_erp]
    return {
        # Locked installations show only their system; demo data stays available until it is connected.
        "erp_locked": bool(lock_erp),
        "erp_connector": lock_erp or s.erp_connector,
        "erp_demo": s.erp_connector == "mock",
        "erp_options": [{"key": o["key"], "name": o["name"], "info": ERP_INFO.get(o["key"], ""),
                         "fields": _describe(ERP_FIELDS.get(o["key"], []))} for o in erp_options],
        "zoho_scopes": ZOHO_SCOPES,
        "erp_demo_email": s.demo_customer_email,
        "ai_locked": bool(lock_ai),
        "ai_provider": s.ai_provider,
        "ai_options": [{"key": k, "name": AI_INFO[k], "fields": _describe(v)} for k, v in AI_FIELDS.items()
                       if not lock_ai or k == lock_ai],
        "mail": _describe(MAIL_FIELDS),
        "rules": _describe(RULE_FIELDS),
        "security": _describe(SECURITY_FIELDS),
        "price_list": {"dir": str(s.standalone_dir), "present": bool(connectors.load("standalone").price_list)},
    }


def apply(values: dict[str, str]) -> list[str]:
    """Validate, persist to .env, and hot-reload settings and clients. Returns the keys changed."""
    allowed = _all_fields()
    changes: dict[str, str] = {}
    for key, value in values.items():
        value = "" if value is None else str(value).strip()
        if key in SELECTORS:
            options = connectors.CONNECTORS if key == "ERP_CONNECTOR" else ai.PROVIDERS
            if value not in options:
                raise ValueError(f"{key}: unknown option '{value}'")
            s = get_settings()
            if key == "ERP_CONNECTOR" and s.lock_erp_connector and value not in (s.lock_erp_connector, "mock"):
                raise ValueError(f"This installation is set up for {connectors.CONNECTORS[s.lock_erp_connector][2]} only")
            if key == "AI_PROVIDER" and s.lock_ai_provider and value != s.lock_ai_provider:
                raise ValueError(f"This installation uses {AI_INFO[s.lock_ai_provider]} only")
        elif key not in allowed:
            raise ValueError(f"{key} can't be changed from the dashboard")
        else:
            kind = allowed[key][2]
            if kind == "secret" and not value:
                continue  # empty = keep current
            if kind == "number" and value:
                float(value)
            if kind == "bool":
                value = "true" if value.lower() in ("1", "true", "yes", "on") else "false"
            if kind.startswith("select:") and value not in kind[7:].split(","):
                raise ValueError(f"{key}: choose one of {kind[7:]}")
            if "\n" in value:
                raise ValueError(f"{key}: line breaks are not allowed")
        changes[key] = value
    if changes:
        update_env(changes)
        os.environ.update(changes)
        reload()
    return sorted(changes)


# --- Zoho Books: one-time grant code -> refresh token -> organization ------------------------------

_pending: dict[str, dict] = {}  # refresh tokens waiting for the user to pick an organization (10 minutes)


async def zoho_connect(dc: str, client_id: str, client_secret: str, code: str) -> dict:
    dc = (dc or "in").strip().lower()
    if dc not in ("in", "com", "eu", "com.au", "jp", "ca", "sa", "com.cn"):
        raise ValueError("Unknown Zoho data centre")
    if not (client_id and client_secret and code):
        raise ValueError("Client ID, client secret and the generated code are all required")
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(f"https://accounts.zoho.{dc}/oauth/v2/token", params={
            "code": code.strip(), "client_id": client_id.strip(), "client_secret": client_secret.strip(),
            "grant_type": "authorization_code"})
        data = r.json() if r.content else {}
        if "refresh_token" not in data:
            err = data.get("error", r.text[:200])
            hint = (" — the code expired or was already used; generate a new one (codes last a few minutes and work once)"
                    if err in ("invalid_code", "invalid_grant") else " — check the client ID/secret and the data centre")
            raise ValueError(f"Zoho said: {err}{hint}")
        orgs_resp = await client.get(f"https://www.zohoapis.{dc}/books/v3/organizations",
                                     headers={"Authorization": f"Zoho-oauthtoken {data['access_token']}"})
    orgs = [{"id": str(o["organization_id"]), "name": o.get("name", "")}
            for o in (orgs_resp.json() if orgs_resp.content else {}).get("organizations", [])]
    if not orgs:
        raise ValueError("Connected, but no Zoho Books organization is visible — check the scopes and that Books is set up")
    pending = {"dc": dc, "client_id": client_id.strip(), "client_secret": client_secret.strip(),
               "refresh_token": data["refresh_token"], "orgs": orgs, "at": time.time()}
    if len(orgs) == 1:
        return _save_zoho(pending, orgs[0]["id"])
    token = secrets.token_urlsafe(16)
    _pending[token] = pending
    return {"connected": False, "choose": orgs, "pending": token}


def zoho_choose(token: str, organization_id: str) -> dict:
    pending = _pending.pop(token, None)
    if not pending or time.time() - pending["at"] > 600:
        raise ValueError("That connection attempt expired — generate a new code and connect again")
    if organization_id not in {o["id"] for o in pending["orgs"]}:
        raise ValueError("Pick one of the listed organizations")
    return _save_zoho(pending, organization_id)


def _save_zoho(p: dict, org_id: str) -> dict:
    s = get_settings()
    values = {"ZOHO_DC": p["dc"], "ZOHO_CLIENT_ID": p["client_id"], "ZOHO_CLIENT_SECRET": p["client_secret"],
              "ZOHO_REFRESH_TOKEN": p["refresh_token"], "ZOHO_ORGANIZATION_ID": org_id}
    if not s.lock_erp_connector or s.lock_erp_connector == "zoho_books":
        values["ERP_CONNECTOR"] = "zoho_books"  # leaves demo mode
    update_env(values)
    os.environ.update(values)
    reload()
    name = next((o["name"] for o in p["orgs"] if o["id"] == org_id), org_id)
    return {"connected": True, "organization": {"id": org_id, "name": name}}


def reload() -> None:
    get_settings.cache_clear()
    connectors._instance = None
    ai._gemini = None
    ai._anthropic = None
