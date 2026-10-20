"""Go-live readiness: what is configured (instant) and whether each live connection works (on demand).

Live checks only read or log in — they never create quotations or send email.
"""
from __future__ import annotations

import asyncio
import smtplib
import ssl

import anthropic
import httpx
from google import genai

from . import auth, inbox
from .config import get_settings
from .connectors import get_connector

AI_FIX = {
    "gemini": "aistudio.google.com → Get API key; paste it in Setup → AI",
    "anthropic": "platform.claude.com → API Keys; paste it in Setup → AI",
    "openai": "Set the API base URL, key and model in Setup → AI",
}


def config_checks() -> list[dict]:
    s = get_settings()
    erp = get_connector()
    erp_ok, erp_detail, erp_fix = erp.readiness()
    return [
        {"key": "erp", "label": f"Accounting system: {erp.name}", "ok": erp_ok, "detail": erp_detail,
         "fix": erp_fix or "Choose your accounting system in Setup"},
        {"key": "ai", "label": f"AI layer ({s.ai_provider_label})", "ok": s.ai_enabled,
         "detail": f"{s.ai_provider_label} · {s.active_ai_model}" if s.ai_enabled else "Off — rules only; unfamiliar layouts and PDFs fail",
         "fix": AI_FIX[s.ai_provider]},
        {"key": "smtp", "label": "Outbound email (SMTP)", "ok": s.smtp_enabled,
         "detail": f"{s.smtp_user} via {s.smtp_host}:{s.smtp_port}" if s.smtp_enabled else "Emails are logged to the dashboard only",
         "fix": "Mailbox app password → Setup → Email"},
        {"key": "imap", "label": "Monitored inbox (IMAP)", "ok": s.imap_enabled,
         "detail": (f"{s.imap_user} via {s.imap_host}, every {s.imap_poll_seconds}s" if s.imap_poll_seconds else "manual polling")
         if s.imap_enabled else "Polling off — use dashboard upload / samples",
         "fix": "Turn on IMAP in your mailbox settings, then add the app password in Setup → Email"},
        {"key": "login", "label": "Dashboard login", "ok": auth.enabled(),
         "detail": f"User '{s.admin_user}'" if auth.enabled() else "No password — anyone who can open the dashboard can use it",
         "fix": "Set an admin password in Setup → Security"},
    ]


async def _erp() -> str:
    return await get_connector().check()


async def _ai() -> str:
    s = get_settings()
    if s.ai_provider == "gemini":
        model = await genai.Client(api_key=s.gemini_api_key).aio.models.get(model=s.gemini_model)
        return f"API key valid; {model.display_name or s.gemini_model} available"
    if s.ai_provider == "anthropic":
        model = await anthropic.AsyncAnthropic(timeout=20.0).models.retrieve(s.ai_model)
        return f"API key valid; {model.display_name} available"
    headers = {"Authorization": f"Bearer {s.openai_api_key}"} if s.openai_api_key else {}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{s.openai_base_url}/models", headers=headers)
    r.raise_for_status()
    ids = {m.get("id") for m in r.json().get("data", [])}
    return f"Connected to {s.openai_base_url}; model '{s.openai_model}' " + ("available" if s.openai_model in ids else "not in the server's model list")


def _smtp() -> str:
    s = get_settings()
    if s.smtp_starttls:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(s.smtp_user, s.smtp_password)
    else:
        with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=20, context=ssl.create_default_context()) as smtp:
            smtp.login(s.smtp_user, s.smtp_password)
    return f"Logged in as {s.smtp_user} (nothing sent)"


async def live_checks() -> list[dict]:
    s = get_settings()
    erp = get_connector()
    plan = [
        ("erp", erp.name, erp.readiness()[0] or erp.is_mock, _erp, erp.readiness()[2] or "not configured"),
        ("ai", f"{s.ai_provider_label} API", s.ai_enabled, _ai, "AI provider not configured"),
        ("smtp", "SMTP login", s.smtp_enabled, lambda: asyncio.to_thread(_smtp), "SMTP password not set"),
        ("imap", "IMAP login", s.imap_enabled, lambda: asyncio.to_thread(inbox.check), "IMAP password not set"),
    ]
    results = []
    for key, label, configured, fn, why_skip in plan:
        if not configured:
            results.append({"key": key, "label": label, "ok": None, "detail": f"Skipped — {why_skip}"})
            continue
        try:
            results.append({"key": key, "label": label, "ok": True, "detail": await fn()})
        except Exception as exc:
            results.append({"key": key, "label": label, "ok": False, "detail": f"{type(exc).__name__}: {exc}"})
    return results
