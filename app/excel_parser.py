"""Excel/CSV quote-request parsing.

Rule-based fast path: find the header row anywhere in the first rows of any sheet and map
columns through synonym lists (handles SAP-style exports such as
Material | Short text | Long Text | Req. Qty | UOM | Unit Price | Remarks | Delivery Period).
When no header can be recognised, `NoItemTable` carries the raw rows so the pipeline can ask
the AI layer for a column mapping and then reuse `rows_to_items` unchanged.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from .email_parser import ParseError, parse_date
from .schemas import LineItem

# Canonical field -> header spellings. Exact matches win over substring matches.
COLUMN_SYNONYMS: dict[str, list[str]] = {
    "sku": ["sku", "item code", "code", "part no", "part number", "part #", "product code", "item no",
            "item #", "item id", "article no", "material no", "material number", "material code",
            "mat code", "sap code", "model no", "catalogue no", "cat no"],
    "name": ["item", "item name", "product", "product name", "name", "short text", "short description",
             "item short text", "item details", "particulars"],
    "description": ["description", "item description", "long text", "long description",
                    "detailed description", "full description", "specification", "specs", "details"],
    "quantity": ["qty", "quantity", "req qty", "qty required", "required qty", "order qty", "nos",
                 "units required", "requirement"],
    "unit": ["uom", "unit", "unit of measure", "units of measure", "uom code", "unit of measurement"],
    "customer_rate": ["unit price", "price", "rate", "target price", "unit rate", "price per unit",
                      "expected price", "net price"],
    "remarks": ["remarks", "remark", "comments", "comment", "notes", "note"],
    "delivery": ["delivery period", "delivery", "lead time", "delivery time", "delivery schedule"],
}
# Headers whose meaning depends on the values underneath (SAP "Material" is a code; elsewhere a name).
AMBIGUOUS_HEADERS = {"material": ("sku", "name"), "item": ("name", "sku")}

META_KEYS: dict[str, list[str]] = {
    "customer_name": ["customer", "customer name", "company", "company name", "client", "bill to",
                      "organisation", "organization", "buyer"],
    "contact_name": ["contact", "contact person", "attention", "attn", "requested by"],
    "customer_email": ["email", "e mail", "contact email"],
    "reference": ["reference", "ref", "ref no", "rfq", "rfq no", "rfq number", "enquiry no", "po",
                  "po no", "po number", "pr no", "pr number"],
    "required_by": ["required by", "delivery date", "deliver by", "need by", "needed by", "due date",
                    "required date"],
    "notes": ["notes", "note", "remarks", "comments", "special instructions"],
    "contact_phone": ["phone", "mobile", "tel", "telephone", "contact no", "contact number", "mobile no", "phone no"],
    "delivery_address": ["delivery address", "ship to", "shipping address", "deliver to", "site address", "consignee"],
    "delivery_terms": ["delivery terms", "incoterms", "freight", "shipping terms", "terms of delivery"],
}

MAX_HEADER_SCAN_ROWS = 25
CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-_/.]{2,}$")


@dataclass
class ExcelResult:
    meta: dict[str, Any]
    items: list[LineItem]
    warnings: list[str] = field(default_factory=list)
    sheet: str = ""
    header_row: int = 0
    mapping: dict[str, int] = field(default_factory=dict)
    mapped_by: str = "rules"  # rules | ai


class NoItemTable(ParseError):
    """No recognisable header. `sheets` holds raw rows for the AI column mapper."""

    def __init__(self, message: str, sheets: dict[str, list[list[Any]]]):
        super().__init__(message)
        self.sheets = sheets


# --- cell helpers -------------------------------------------------------------

def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, float) and pd.isna(value)) or (isinstance(value, str) and not value.strip())


def _norm(value: Any) -> str:
    if _is_blank(value):
        return ""
    text = str(value).strip().lower().replace("\n", " ")
    text = re.sub(r"[^a-z0-9# ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_text(value: Any) -> str | None:
    if _is_blank(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))  # 1300077549.0 -> "1300077549"
    text = str(value).replace("_x000D_", "").replace("\r", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    return text or None


def to_number(value: Any) -> float | None:
    if _is_blank(value):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = re.search(r"-?\d[\d,]*(?:\.\d+)?", str(value))
    return float(m.group(0).replace(",", "")) if m else None


def _looks_like_codes(values: list[Any]) -> bool:
    vals = [clean_text(v) for v in values if not _is_blank(v)]
    return bool(vals) and sum(bool(CODE_RE.match(v)) for v in vals) / len(vals) >= 0.7


# --- header detection ---------------------------------------------------------

def _map_header(row: list[Any], below: list[list[Any]]) -> dict[str, int]:
    cells = [_norm(v) for v in row]
    mapping: dict[str, int] = {}

    def take(field_: str, idx: int) -> None:
        if field_ not in mapping and idx not in mapping.values():
            mapping[field_] = idx

    for field_, names in COLUMN_SYNONYMS.items():  # pass 1: exact
        for idx, cell in enumerate(cells):
            if cell in names:
                take(field_, idx)
    for idx, cell in enumerate(cells):  # ambiguous headers decided by their values
        if cell in AMBIGUOUS_HEADERS and idx not in mapping.values():
            as_code, as_text = AMBIGUOUS_HEADERS[cell]
            column = [r[idx] for r in below if idx < len(r)]
            take("sku" if _looks_like_codes(column) else ("name" if as_code == "sku" else as_text), idx)
    for field_, names in COLUMN_SYNONYMS.items():  # pass 2: contains
        for idx, cell in enumerate(cells):
            if cell and any(len(n) > 3 and n in cell for n in names):
                take(field_, idx)
    return mapping


def is_item_header(mapping: dict[str, int]) -> bool:
    return "quantity" in mapping and bool({"sku", "name", "description"} & mapping.keys())


def _read_metadata(rows: list[list[Any]]) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    for row in rows:
        cells = [c for c in row if not _is_blank(c)]
        for i, cell in enumerate(cells):
            text = str(cell)
            nxt = cells[i + 1] if i + 1 < len(cells) else None
            if ":" in text and not isinstance(cell, (int, float)):
                key, _, val = text.partition(":")
                val = val.strip() or nxt
            else:
                key, val = text, nxt
            nkey = _norm(key)
            for field_, names in META_KEYS.items():
                if nkey in names and field_ not in meta and not _is_blank(val):
                    meta[field_] = val
    if "required_by" in meta:
        meta["required_by"] = parse_date(meta["required_by"])
    for k in ("customer_name", "contact_name", "customer_email", "reference", "notes", "contact_phone",
              "delivery_address", "delivery_terms"):
        if k in meta:
            meta[k] = clean_text(meta[k])
    return meta


def load_sheets(data: bytes, filename: str) -> dict[str, list[list[Any]]]:
    name = (filename or "").lower()
    try:
        if name.endswith(".csv"):
            frames = {"csv": pd.read_csv(io.BytesIO(data), header=None, dtype=object)}
        elif name.endswith(".xls"):  # legacy Excel 97-2003, common in SAP exports
            frames = pd.read_excel(io.BytesIO(data), sheet_name=None, header=None, dtype=object, engine="xlrd")
        else:
            frames = pd.read_excel(io.BytesIO(data), sheet_name=None, header=None, dtype=object, engine="openpyxl")
    except Exception as exc:  # corrupt / password-protected / not a spreadsheet
        raise ParseError(f"Could not read spreadsheet '{filename}': {exc}") from exc
    return {sheet: df.astype(object).where(pd.notna(df), None).values.tolist() for sheet, df in frames.items()}


# --- rows -> items --------------------------------------------------------------

def rows_to_items(rows: list[list[Any]], header_idx: int, mapping: dict[str, int]) -> list[LineItem]:
    items: list[LineItem] = []
    for row_idx, row in enumerate(rows[header_idx + 1 :], start=header_idx + 1):
        def get(f: str) -> Any:
            i = mapping.get(f)
            return row[i] if i is not None and i < len(row) else None

        first = _norm(next((c for c in row if not _is_blank(c)), ""))
        if first.startswith(("total", "grand total", "sub total", "subtotal")):
            break
        sku, name, desc = clean_text(get("sku")), clean_text(get("name")), clean_text(get("description"))
        qty_raw = get("quantity")
        if not any([sku, name, desc, clean_text(qty_raw)]):
            continue  # blank spacer row
        rate = to_number(get("customer_rate"))
        items.append(
            LineItem(
                line_no=len(items) + 1,
                source="excel",
                sku=sku,
                name=name or (desc.split("\n")[0][:120] if desc else None),
                description=desc,
                quantity=to_number(qty_raw),
                quantity_raw=clean_text(qty_raw),
                unit=clean_text(get("unit")),
                customer_rate=rate if rate else None,  # 0 / blank = "please quote"
                remarks=clean_text(get("remarks")),
                delivery=clean_text(get("delivery")),
                source_row=row_idx,
            )
        )
    return items


def parse_excel(data: bytes, filename: str) -> ExcelResult:
    """Rule-based parse. Raises NoItemTable (with raw rows) when no header is recognised."""
    sheets = load_sheets(data, filename)
    for sheet_name, rows in sheets.items():
        for i, row in enumerate(rows[:MAX_HEADER_SCAN_ROWS]):
            mapping = _map_header(row, rows[i + 1 : i + 11])
            if is_item_header(mapping):
                return build_result(rows, i, mapping, sheet_name, "rules")
    raise NoItemTable(
        f"No item table recognised in '{filename}' (need a quantity column plus an item code/name/description column).",
        sheets,
    )


def build_result(rows: list[list[Any]], header_idx: int, mapping: dict[str, int], sheet: str, mapped_by: str) -> ExcelResult:
    items = rows_to_items(rows, header_idx, mapping)
    warnings = []
    missing = [f for f in ("sku", "unit") if f not in mapping]
    if missing:
        warnings.append(f"Sheet '{sheet}': no column found for {', '.join(missing)}")
    return ExcelResult(
        meta=_read_metadata(rows[:header_idx]),
        items=items,
        warnings=warnings,
        sheet=sheet,
        header_row=header_idx,
        mapping=mapping,
        mapped_by=mapped_by,
    )


def preview_rows(rows: list[list[Any]], limit: int = 20, cell_chars: int = 80) -> list[list[str]]:
    """Compact, truncated view of the top of a sheet for the AI column mapper."""
    out = []
    for row in rows[:limit]:
        out.append([(clean_text(c) or "")[:cell_chars] for c in row])
    return out
