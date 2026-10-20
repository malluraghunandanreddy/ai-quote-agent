"""AI providers (Gemini, OpenAI-compatible, Claude) against fake servers — request shape, parsing, PDF input."""
import json

import httpx
import pytest

from app import ai
from tests.conftest import reset_caches, run_sample


def answer(prompt: str) -> dict:
    """Canned structured output, chosen by which job the prompt is for."""
    if "Find the table of requested items" in prompt:
        return {"sheet": "Sheet", "header_row_index": 3, "sku": 2, "name": 1, "description": None, "quantity": 3,
                "unit": 4, "customer_rate": None, "remarks": None, "delivery": None, "found_item_table": True}
    if "Match each customer line item" in prompt:
        lines = json.loads(prompt.split("<lines>")[1].split("</lines>")[0])
        return {"matches": [{"line_no": l["line_no"], "item_id": None, "confidence": 0.2, "reason": "no match"} for l in lines]}
    doc = "attached this document" in prompt
    items = [{"sku": "1300043319", "name": "Junction box 4x4x2 GI", "description": None, "quantity": 14, "unit": "EA",
              "customer_rate": None, "remarks": None},
             {"sku": None, "name": "Duct tape 50mm", "description": None, "quantity": 5, "unit": "EA",
              "customer_rate": None, "remarks": None}] if doc or "Nothing usable is attached" in prompt else []
    return {"is_quote_request": True, "customer_name": "Demo Customer Pvt Ltd", "contact_name": "Ravi Kumar",
            "customer_email": None, "contact_phone": None, "delivery_address": "Vizag plant" if doc else None,
            "delivery_terms": None, "reference": "RFQ-ELEC-0944" if doc else None, "required_by": None,
            "notes": None, "line_items": items}


def use(monkeypatch, **env):
    for k, v in {"AI_ENABLED": "true", **env}.items():
        monkeypatch.setenv(k, v)
    reset_caches()


def test_gemini_reads_pdf_enquiry(client, monkeypatch):
    use(monkeypatch, AI_PROVIDER="gemini", GEMINI_API_KEY="AIza-test")
    from google import genai
    from google.genai import types as gt
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        text = next(p["text"] for p in body["contents"][0]["parts"] if "text" in p)
        return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(answer(text))}]},
                                                         "finishReason": "STOP"}]})

    ai._gemini = genai.Client(api_key="AIza-test", http_options=gt.HttpOptions(
        httpx_async_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))))
    d = run_sample(client, "pdf_rfq")
    assert [l["sku"] for l in d["line_items"]] == ["1300043319", None] and d["mapped_by"] == "ai"
    assert d["reference"] == "RFQ-ELEC-0944" and d["delivery_address"] == "Vizag plant"
    pdf_parts = [p for b in seen for p in b["contents"][0]["parts"] if "inlineData" in p]
    inline = pdf_parts[0]["inlineData"] if pdf_parts else {}
    assert (inline.get("mimeType") or inline.get("mime_type")) == "application/pdf"  # SDK may use either casing
    assert all("$defs" not in json.dumps(b["generationConfig"]["responseJsonSchema"]) for b in seen)


def test_openai_compatible_with_json_mode_fallback(client, monkeypatch):
    use(monkeypatch, AI_PROVIDER="openai", OPENAI_API_KEY="k", OPENAI_MODEL="any-model",
        OPENAI_BASE_URL="http://llm.local/v1")
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        if body["response_format"]["type"] == "json_schema" and len(seen) == 1:
            return httpx.Response(400, json={"error": {"message": "response_format json_schema not supported"}})
        user = body["messages"][1]["content"]
        text = user if isinstance(user, str) else user[0]["text"]
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(answer(text))}, "finish_reason": "stop"}]})

    real = httpx.AsyncClient
    monkeypatch.setattr(ai.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    d = run_sample(client, "inline_email")
    assert len(d["line_items"]) == 2 and d["mapped_by"] == "ai"
    assert seen[0]["response_format"]["json_schema"]["strict"] is True
    assert seen[1]["response_format"] == {"type": "json_object"}  # fell back for a server without schema support


def test_claude_request_shape(client, monkeypatch):
    use(monkeypatch, AI_PROVIDER="anthropic", ANTHROPIC_API_KEY="sk-ant-test")
    import anthropic
    import httpx2
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body)
        content = body["messages"][0]["content"]
        text = content if isinstance(content, str) else content[-1]["text"]
        return httpx2.Response(200, json={"id": "m", "type": "message", "role": "assistant", "model": body["model"],
                                          "content": [{"type": "text", "text": json.dumps(answer(text))}],
                                          "stop_reason": "end_turn", "stop_sequence": None,
                                          "usage": {"input_tokens": 1, "output_tokens": 1}})

    ai._anthropic = anthropic.AsyncAnthropic(api_key="sk-ant-test", http_client=anthropic.DefaultAsyncHttpxClient(
        transport=httpx2.MockTransport(handler)))
    d = run_sample(client, "pdf_rfq")
    assert len(d["line_items"]) == 2
    doc_req = [b for b in seen if isinstance(b["messages"][0]["content"], list)][0]
    assert doc_req["messages"][0]["content"][0]["type"] == "document"
    assert seen[0]["fallbacks"] == "default" and seen[0]["output_config"]["format"]["type"] == "json_schema"


def test_unknown_provider_is_an_error(monkeypatch):
    use(monkeypatch, AI_PROVIDER="gemini", GEMINI_API_KEY="x")
    monkeypatch.setattr(ai, "PROVIDERS", {})
    import asyncio
    with pytest.raises(ai.AIError):
        asyncio.run(ai.extract_email("s", "b", "x@y.z", False))
