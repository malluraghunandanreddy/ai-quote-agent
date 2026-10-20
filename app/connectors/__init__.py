"""ERP connector registry — the plug-and-play point for accounting systems.

Select one with ERP_CONNECTOR in .env. To add a system, implement `Connector` (see base.py and
CONNECTORS.md) and add one line to CONNECTORS below.
"""
from __future__ import annotations

import importlib

from ..config import get_settings
from .base import Connector, ConnectorError

# key -> (module, class, display name)
CONNECTORS: dict[str, tuple[str, str, str]] = {
    "mock": ("app.connectors.mock", "MockConnector", "Demo catalogue (mock)"),
    "zoho_books": ("app.connectors.zoho_books", "ZohoBooksConnector", "Zoho Books"),
    "standalone": ("app.connectors.standalone", "StandaloneConnector", "No accounting software (PDF quotes by email)"),
    "webhook": ("app.connectors.webhook", "WebhookConnector", "Webhook (Zapier / Make / n8n / custom)"),
}

_instance: Connector | None = None


def load(key: str) -> Connector:
    if key not in CONNECTORS:
        raise ConnectorError(f"Unknown ERP_CONNECTOR '{key}'. Available: {', '.join(CONNECTORS)}", retryable=False)
    module, cls, _ = CONNECTORS[key]
    return getattr(importlib.import_module(module), cls)()


def get_connector() -> Connector:
    global _instance
    if _instance is None:
        _instance = load(get_settings().erp_connector)
    return _instance


def options() -> list[dict]:
    return [{"key": k, "name": v[2]} for k, v in CONNECTORS.items()]


__all__ = ["Connector", "ConnectorError", "get_connector", "load", "options", "CONNECTORS"]
