"""Minimal dashboard login: one admin account from .env, HMAC-signed session cookie (no extra dependency)."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time

from .config import get_settings
from .envfile import update_env

COOKIE = "qa_session"
SESSION_SECONDS = 12 * 3600


def _secret() -> bytes:
    s = get_settings()
    if not s.session_secret:  # first start: create and persist one
        value = secrets.token_hex(32)
        update_env({"SESSION_SECRET": value})
        os.environ["SESSION_SECRET"] = value
        get_settings.cache_clear()
        return value.encode()
    return s.session_secret.encode()


def enabled() -> bool:
    return bool(get_settings().admin_password)


def check_password(user: str, password: str) -> bool:
    s = get_settings()
    return hmac.compare_digest(user.encode(), s.admin_user.encode()) and hmac.compare_digest(password.encode(), s.admin_password.encode())


def make_token(user: str) -> str:
    expiry = str(int(time.time()) + SESSION_SECONDS)
    sig = hmac.new(_secret(), f"{user}|{expiry}".encode(), hashlib.sha256).hexdigest()
    return f"{user}|{expiry}|{sig}"


def verify(token: str | None) -> str | None:
    """Return the user for a valid, unexpired token."""
    try:
        user, expiry, sig = (token or "").split("|")
    except ValueError:
        return None
    good = hmac.new(_secret(), f"{user}|{expiry}".encode(), hashlib.sha256).hexdigest()
    if hmac.compare_digest(sig, good) and int(expiry) > time.time():
        return user
    return None
