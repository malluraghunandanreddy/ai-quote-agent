"""Rule-based item matching against the Zoho catalogue, plus candidate shortlists for the AI matcher."""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from .schemas import CatalogItem, ItemMatch, LineItem


def norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _tokens(text: str | None) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(t) > 1}


def match_rules(lines: list[LineItem], catalog: list[CatalogItem], threshold: float) -> dict[int, ItemMatch]:
    by_sku = {norm(i.sku): i for i in catalog if i.sku}
    by_name = {norm(i.name): i for i in catalog}
    out: dict[int, ItemMatch] = {}
    for li in lines:
        if li.sku and norm(li.sku) in by_sku:
            out[li.line_no] = ItemMatch(line_no=li.line_no, item=by_sku[norm(li.sku)], method="sku", score=1.0)
            continue
        if li.name and norm(li.name) in by_name:
            out[li.line_no] = ItemMatch(line_no=li.line_no, item=by_name[norm(li.name)], method="name", score=1.0)
            continue
        best, best_score = None, 0.0
        target = norm(li.name)
        if target:
            for item in catalog:
                score = SequenceMatcher(None, target, norm(item.name)).ratio()
                if score > best_score:
                    best, best_score = item, score
        if best is not None and best_score >= threshold:
            out[li.line_no] = ItemMatch(line_no=li.line_no, item=best, method="fuzzy", score=round(best_score, 3))
        else:
            out[li.line_no] = ItemMatch(line_no=li.line_no)
    return out


def shortlist(li: LineItem, catalog: list[CatalogItem], k: int = 8) -> list[CatalogItem]:
    """Top-k catalogue items by token overlap — keeps the AI prompt small for large catalogues."""
    want = _tokens(" ".join(filter(None, [li.sku, li.name, (li.description or "")[:400]])))
    scored = []
    for item in catalog:
        have = _tokens(" ".join(filter(None, [item.sku, item.name, item.description])))
        overlap = len(want & have)
        if overlap:
            scored.append((overlap / (len(have) ** 0.5 or 1), item))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [item for _, item in scored[:k]]
