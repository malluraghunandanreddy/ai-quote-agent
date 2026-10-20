"""Pydantic models passed between pipeline stages."""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


class AttachmentFile(BaseModel):
    name: str
    content_type: str = "application/octet-stream"
    data: bytes = Field(repr=False)


class RawEnquiry(BaseModel):
    """An inbound quote request exactly as received (email + attachments: Excel, PDF, image, Word)."""

    source: str  # imap | upload | sample
    sender_email: str
    sender_name: str | None = None
    subject: str = ""
    body_text: str = ""
    message_id: str | None = None
    received_at: datetime = Field(default_factory=datetime.now)
    attachment_name: str | None = None              # primary attachment (first spreadsheet, else first file)
    attachment_bytes: bytes | None = Field(default=None, repr=False)
    attachments: list[AttachmentFile] = []          # every usable attachment, in email order


class LineItem(BaseModel):
    line_no: int
    source: str = "excel"  # excel | email
    sku: str | None = None
    name: str | None = None
    description: str | None = None
    quantity: float | None = None
    quantity_raw: str | None = None  # original cell text, for validation messages
    unit: str | None = None
    customer_rate: float | None = None
    remarks: str | None = None
    delivery: str | None = None
    source_row: int | None = None  # 0-based sheet row, for the source-vs-result view


class ExtractedEnquiry(BaseModel):
    customer_name: str | None = None
    contact_name: str | None = None
    customer_email: str | None = None
    contact_phone: str | None = None
    delivery_address: str | None = None
    delivery_terms: str | None = None
    reference: str | None = None
    required_by: date | None = None
    notes: str | None = None
    line_items: list[LineItem] = []
    warnings: list[str] = []
    source_sheet: str | None = None
    source_header_row: int | None = None
    source_mapping: dict[str, int] | None = None
    mapped_by: str | None = None  # rules | ai | email


class ValidationResult(BaseModel):
    errors: list[str] = []
    warnings: list[str] = []

    @property
    def ok(self) -> bool:
        return not self.errors


class CatalogItem(BaseModel):
    item_id: str
    name: str
    sku: str | None = None
    rate: float = 0.0
    unit: str | None = None
    description: str | None = None


class ItemMatch(BaseModel):
    line_no: int
    item: CatalogItem | None = None
    method: str | None = None  # sku | name | fuzzy
    score: float = 0.0


class CustomerMatch(BaseModel):
    contact_id: str
    contact_name: str
    email: str | None = None
    method: str  # email | name


class QuoteLine(BaseModel):
    item_id: str | None  # None = unlinked line (product not in the ERP's master)
    name: str
    description: str = ""
    quantity: float
    rate: float
    unit: str | None = None
    discount_percent: float | None = None


class DraftQuote(BaseModel):
    """What the agent asks a connector to create. Always a draft; never sent to the customer."""
    customer_id: str
    customer_name: str
    customer_email: str | None = None
    reference: str
    quote_date: date
    expiry_date: date
    notes: str
    lines: list[QuoteLine]
    contact_phone: str | None = None
    delivery_address: str | None = None
    delivery_terms: str | None = None


class QuoteResult(BaseModel):
    quote_id: str
    quote_number: str
    status: str
    total: float
    currency: str | None = None
    url: str | None = None
    attachments: list[str] = []  # document files to attach to the Sales email (standalone mode: PDF, Excel)


class PriceResult(BaseModel):
    rate: float
    discount_percent: float | None = None
    note: str | None = None  # e.g. "price list: Distributor"
