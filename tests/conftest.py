"""Every test runs against its own temp database, .env copy and standalone folder — real data is never touched."""
from __future__ import annotations

import os

# Must happen before anything imports app.config: tests never read the real .env.
os.environ["QUOTE_AGENT_ENV_FILE"] = os.devnull

import shutil
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

BASE_ENV = {
    "ERP_CONNECTOR": "mock", "AI_PROVIDER": "gemini", "AI_ENABLED": "false",
    "LOCK_ERP_CONNECTOR": "", "LOCK_AI_PROVIDER": "",
    "GEMINI_API_KEY": "", "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "", "OPENAI_MODEL": "",
    "SMTP_HOST": "", "SMTP_PASSWORD": "", "IMAP_HOST": "", "IMAP_PASSWORD": "",
    "ADMIN_PASSWORD": "", "SESSION_SECRET": "test-secret", "UNMATCHED_ITEM_POLICY": "free_text",
    "REQUIRED_ENQUIRY_FIELDS": "", "RETRY_ATTEMPTS": "3", "RETRY_DELAY_SECONDS": "0",
    "STANDALONE_TAX_PERCENT": "0", "WEBHOOK_URL": "", "WEBHOOK_SECRET": "",
    "SALES_TEAM_EMAIL": "sales@example.test", "ALERT_RECIPIENTS": "a@example.test,b@example.test,c@example.test",
}


def reset_caches() -> None:
    from app import ai, connectors
    from app.config import get_settings
    get_settings.cache_clear()
    connectors._instance = None
    ai._gemini = None
    ai._anthropic = None


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    standalone = tmp_path / "standalone"
    standalone.mkdir()
    shutil.copy(ROOT / "data" / "standalone" / "price_list.xlsx", standalone / "price_list.xlsx")
    env_file = tmp_path / ".env"
    env_file.write_text((ROOT / ".env.example").read_text())
    for k, v in {**BASE_ENV, "DB_PATH": str(tmp_path / "test.db"), "STANDALONE_DIR": str(standalone)}.items():
        monkeypatch.setenv(k, v)
    from app import envfile
    monkeypatch.setattr(envfile, "ENV_PATH", env_file)
    reset_caches()
    from app import db
    db.init_db()
    yield tmp_path
    reset_caches()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c


def wait_done(client, eid: int, timeout: float = 10) -> dict:
    """Poll until background processing settles."""
    end = time.time() + timeout
    while time.time() < end:
        d = client.get(f"/api/enquiries/{eid}").json()
        if d["status"] not in ("PROCESSING", "RECEIVED"):
            time.sleep(0.05)  # let the finally-block timing update land
            return client.get(f"/api/enquiries/{eid}").json()
        time.sleep(0.05)
    raise AssertionError(f"enquiry {eid} still processing")


def run_sample(client, key: str) -> dict:
    r = client.post(f"/api/samples/{key}")
    assert r.status_code == 200, r.text
    return wait_done(client, r.json()["id"])


def kinds(detail: dict) -> list[str]:
    return [n["kind"] for n in detail["notifications"]]
