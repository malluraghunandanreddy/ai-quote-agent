"""Runtime configuration loaded from .env (python-dotenv) into a pydantic model."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_DIR = BASE_DIR / "data"
SAMPLES_DIR = BASE_DIR / "samples"

# QUOTE_AGENT_ENV_FILE points at another settings file (the test suite uses it to ignore the real .env).
load_dotenv(os.getenv("QUOTE_AGENT_ENV_FILE") or BASE_DIR / ".env")

DEFAULT_IDENTITY = "quotes@demo.example.com"


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _csv(name: str, default: str = "") -> list[str]:
    return [x.strip() for x in _env(name, default).split(",") if x.strip()]


def _bool(name: str, default: bool) -> bool:
    raw = _env(name)
    return default if not raw else raw.lower() in {"1", "true", "yes", "on"}


class Settings(BaseModel):
    app_name: str = "AI Quote Creation Agent"
    db_path: Path

    monitored_inbox: str
    sales_team_email: str
    demo_customer_email: str
    alert_recipients: list[str]

    erp_connector: str          # mock | zoho_books | standalone | … (see app/connectors)
    lock_erp_connector: str     # set per customer installation: only this connector (plus demo data) is offered
    lock_ai_provider: str
    zoho_dc: str
    zoho_client_id: str
    zoho_client_secret: str
    zoho_refresh_token: str
    zoho_org_id: str
    estimate_validity_days: int
    fuzzy_match_threshold: float
    unmatched_item_policy: Literal["free_text", "exception"]

    ai_provider: Literal["gemini", "anthropic", "openai"]
    ai_enabled: bool
    gemini_api_key: str
    gemini_model: str
    openai_api_key: str
    openai_base_url: str
    openai_model: str
    ai_model: str  # Claude model, used when AI_PROVIDER=anthropic
    ai_effort: str
    ai_match_min_confidence: float
    manual_minutes_per_enquiry: float
    manual_minutes_per_line: float

    required_enquiry_fields: list[str]
    retry_attempts: int
    retry_delay_seconds: int
    zoho_http_retries: int
    smtp_retry_attempts: int
    dashboard_url: str

    # standalone ("no accounting software") connector + quotation documents
    standalone_dir: Path
    standalone_auto_create_customers: bool
    standalone_tax_percent: float
    quote_number_prefix: str
    business_name: str
    business_address: str
    business_gstin: str
    business_phone: str
    business_email: str
    quote_terms: str
    webhook_url: str
    webhook_secret: str
    admin_user: str
    admin_password: str
    session_secret: str

    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    smtp_from: str
    smtp_starttls: bool

    imap_host: str
    imap_port: int
    imap_user: str
    imap_password: str
    imap_folder: str
    imap_poll_seconds: int

    # --- derived -----------------------------------------------------------
    @property
    def active_ai_model(self) -> str:
        return {"gemini": self.gemini_model, "anthropic": self.ai_model, "openai": self.openai_model}[self.ai_provider]

    @property
    def ai_provider_label(self) -> str:
        return {"gemini": "Gemini", "anthropic": "Claude", "openai": "OpenAI-compatible"}[self.ai_provider]

    @property
    def smtp_enabled(self) -> bool:
        return bool(self.smtp_host and self.smtp_password)

    @property
    def imap_enabled(self) -> bool:
        return bool(self.imap_host and self.imap_user and self.imap_password)


def _path(value: str) -> Path:
    p = Path(value)
    return p if p.is_absolute() else BASE_DIR / p


def _effective_erp() -> str:
    # ZOHO_MODE=live is the pre-connector spelling of ERP_CONNECTOR=zoho_books.
    erp = _env("ERP_CONNECTOR", "zoho_books" if _env("ZOHO_MODE").lower() == "live" else "mock").lower()
    lock = _env("LOCK_ERP_CONNECTOR").lower()
    return lock if lock and erp not in (lock, "mock") else erp  # a locked installation keeps only demo data as an alternative


def _effective_ai() -> str:
    return _env("LOCK_AI_PROVIDER").lower() or _env("AI_PROVIDER", "gemini").lower()


def _ai_configured(provider: str) -> bool:
    if provider == "gemini":
        return bool(_env("GEMINI_API_KEY"))
    if provider == "anthropic":
        return bool(_env("ANTHROPIC_API_KEY"))
    # OpenAI-compatible: a model is required; the key may be absent for local servers (e.g. Ollama).
    base = _env("OPENAI_BASE_URL", "https://api.openai.com/v1")
    return bool(_env("OPENAI_MODEL")) and (bool(_env("OPENAI_API_KEY")) or "api.openai.com" not in base)


@lru_cache
def get_settings() -> Settings:
    db_path = Path(_env("DB_PATH", "poc_agent.db"))
    if not db_path.is_absolute():
        db_path = BASE_DIR / db_path
    return Settings(
        db_path=db_path,
        monitored_inbox=_env("MONITORED_INBOX", DEFAULT_IDENTITY),
        sales_team_email=_env("SALES_TEAM_EMAIL", DEFAULT_IDENTITY),
        demo_customer_email=_env("DEMO_CUSTOMER_EMAIL", DEFAULT_IDENTITY),
        alert_recipients=_csv("ALERT_RECIPIENTS", DEFAULT_IDENTITY),
        erp_connector=_effective_erp(),
        lock_erp_connector=_env("LOCK_ERP_CONNECTOR").lower(),
        lock_ai_provider=_env("LOCK_AI_PROVIDER").lower(),
        zoho_dc=_env("ZOHO_DC", "in"),
        zoho_client_id=_env("ZOHO_CLIENT_ID"),
        zoho_client_secret=_env("ZOHO_CLIENT_SECRET"),
        zoho_refresh_token=_env("ZOHO_REFRESH_TOKEN"),
        zoho_org_id=_env("ZOHO_ORGANIZATION_ID"),
        estimate_validity_days=int(_env("ESTIMATE_VALIDITY_DAYS", "30")),
        fuzzy_match_threshold=float(_env("FUZZY_MATCH_THRESHOLD", "0.85")),
        unmatched_item_policy=_env("UNMATCHED_ITEM_POLICY", "free_text").lower(),
        ai_provider=_effective_ai(),
        # AI layer is on whenever the chosen provider is configured, unless explicitly disabled.
        ai_enabled=_bool("AI_ENABLED", _ai_configured(_effective_ai())),
        gemini_api_key=_env("GEMINI_API_KEY"),
        gemini_model=_env("GEMINI_MODEL", "gemini-3.8-flash"),
        openai_api_key=_env("OPENAI_API_KEY"),
        openai_base_url=_env("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
        openai_model=_env("OPENAI_MODEL"),
        ai_model=_env("AI_MODEL", "claude-opus-5-5"),
        ai_effort=_env("AI_EFFORT", "medium"),
        ai_match_min_confidence=float(_env("AI_MATCH_MIN_CONFIDENCE", "0.75")),
        manual_minutes_per_enquiry=float(_env("MANUAL_MINUTES_PER_ENQUIRY", "10")),
        manual_minutes_per_line=float(_env("MANUAL_MINUTES_PER_LINE", "2")),
        required_enquiry_fields=_csv("REQUIRED_ENQUIRY_FIELDS"),
        retry_attempts=int(_env("RETRY_ATTEMPTS", "3")),
        retry_delay_seconds=int(_env("RETRY_DELAY_SECONDS", "120")),
        zoho_http_retries=int(_env("ZOHO_HTTP_RETRIES", "2")),
        smtp_retry_attempts=int(_env("SMTP_RETRY_ATTEMPTS", "3")),
        dashboard_url=_env("DASHBOARD_URL", "http://localhost:8000").rstrip("/"),
        standalone_dir=_path(_env("STANDALONE_DIR", "data/standalone")),
        standalone_auto_create_customers=_bool("STANDALONE_AUTO_CREATE_CUSTOMERS", True),
        standalone_tax_percent=float(_env("STANDALONE_TAX_PERCENT", "0")),
        quote_number_prefix=_env("QUOTE_NUMBER_PREFIX", "QT-"),
        business_name=_env("BUSINESS_NAME", "Your Business Name"),
        business_address=_env("BUSINESS_ADDRESS"),
        business_gstin=_env("BUSINESS_GSTIN"),
        business_phone=_env("BUSINESS_PHONE"),
        business_email=_env("BUSINESS_EMAIL", _env("SALES_TEAM_EMAIL", DEFAULT_IDENTITY)),
        quote_terms=_env("QUOTE_TERMS", "Prices valid for the period shown. Taxes and freight as stated."),
        webhook_url=_env("WEBHOOK_URL"),
        webhook_secret=_env("WEBHOOK_SECRET"),
        admin_user=_env("ADMIN_USER", "admin"),
        admin_password=_env("ADMIN_PASSWORD"),
        session_secret=_env("SESSION_SECRET"),
        smtp_host=_env("SMTP_HOST"),
        smtp_port=int(_env("SMTP_PORT", "587")),
        smtp_user=_env("SMTP_USER"),
        smtp_password=_env("SMTP_PASSWORD"),
        smtp_from=_env("SMTP_FROM", DEFAULT_IDENTITY),
        smtp_starttls=_bool("SMTP_STARTTLS", True),
        imap_host=_env("IMAP_HOST"),
        imap_port=int(_env("IMAP_PORT", "993")),
        imap_user=_env("IMAP_USER", DEFAULT_IDENTITY),
        imap_password=_env("IMAP_PASSWORD"),
        imap_folder=_env("IMAP_FOLDER", "INBOX"),
        imap_poll_seconds=int(_env("IMAP_POLL_SECONDS", "60")),
    )
