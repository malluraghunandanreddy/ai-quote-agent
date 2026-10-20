"""Automatic retry for temporary ERP failures, immediate alert for permanent ones, and the duplicate guard."""
import pytest

from app import pipeline
from app.connectors import ConnectorError
from app.connectors.mock import MockConnector
from tests.conftest import kinds, reset_caches, run_sample, wait_done


@pytest.fixture
def flaky(monkeypatch):
    """Make MockConnector.create_draft_quote fail according to a script of statuses (None = success)."""
    script: list = []
    original = MockConnector.create_draft_quote

    async def create(self, quote):
        status = script.pop(0) if script else "ok"
        if status != "ok":
            raise ConnectorError(f"simulated {status}", status=status if isinstance(status, int) else None)
        return await original(self, quote)

    monkeypatch.setattr(MockConnector, "create_draft_quote", create)
    return script


def retry_now(client):
    return client.portal.call(pipeline.run_due_retries)


def test_temporary_failure_is_retried_then_succeeds(client, flaky):
    flaky += [503, 503]
    d = run_sample(client, "excel_rfq")
    assert d["status"] == "RETRY_PENDING" and d["retry_count"] == 1 and kinds(d) == []
    retry_now(client)
    d = wait_done(client, d["id"])
    assert d["status"] == "RETRY_PENDING" and d["retry_count"] == 2
    retry_now(client)
    d = wait_done(client, d["id"])
    assert d["status"] == "NEEDS_REVIEW" and d["retry_count"] == 0
    messages = [e["message"] for e in d["events"] if e["stage"] == "RETRY"]
    assert any("automatic retry 1 of 3" in m for m in messages) and any("automatic retry 2 of 3" in m for m in messages)
    assert "failure" not in kinds(d)


def test_permanent_failure_alerts_immediately(client, flaky):
    flaky += [400]
    d = run_sample(client, "excel_rfq")
    assert (d["status"], d["error_code"], d["retry_count"]) == ("EXCEPTION", "ERP_API_ERROR", 0)
    n = [x for x in d["notifications"] if x["kind"] == "failure"][0]
    assert n["subject"] == "Quote Agent Processing Failure – ERP_API_ERROR"
    assert n["recipients"] == "a@example.test, b@example.test, c@example.test"


def test_gives_up_after_configured_retries(client, flaky, monkeypatch):
    monkeypatch.setenv("RETRY_ATTEMPTS", "2")
    reset_caches()
    flaky += [503, 503, 503]
    d = run_sample(client, "excel_rfq")
    for _ in range(2):
        retry_now(client)
        d = wait_done(client, d["id"])
    assert d["status"] == "EXCEPTION" and "gave up after 2 automatic retries" in d["error_message"]
    assert "failure" in kinds(d)


def test_duplicate_guard_when_reply_was_lost(client, monkeypatch):
    """The ERP created the quote but the reply never arrived: the retry must find it, not create a second one."""
    original = MockConnector.create_draft_quote
    calls = {"n": 0}

    async def create(self, quote):
        calls["n"] += 1
        result = await original(self, quote)
        if calls["n"] == 1:
            raise ConnectorError("connection reset after send")
        return result

    monkeypatch.setattr(MockConnector, "create_draft_quote", create)
    d = run_sample(client, "excel_rfq")
    assert d["status"] == "RETRY_PENDING"
    retry_now(client)
    d = wait_done(client, d["id"])
    from app.connectors import get_connector
    assert d["status"] == "NEEDS_REVIEW" and calls["n"] == 1 and len(get_connector().created) == 1
    assert any("not creating a duplicate" in e["message"] for e in d["events"])
