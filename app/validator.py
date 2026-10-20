"""Business validation of an extracted enquiry before anything touches Zoho."""
from __future__ import annotations

import re
from datetime import date

from .config import get_settings
from .schemas import ExtractedEnquiry, RawEnquiry, ValidationResult

EMAIL_RE = re.compile(r"^[\w.+-]+@[\w-]+(\.[\w-]+)+$")
FIELD_LABELS = {
    "customer_name": "customer name", "contact_name": "contact person", "contact_phone": "contact phone",
    "delivery_address": "delivery address", "delivery_terms": "delivery terms", "reference": "enquiry reference",
    "required_by": "required-by date",
}


def validate(raw: RawEnquiry, ex: ExtractedEnquiry) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = list(ex.warnings)

    if not EMAIL_RE.match(raw.sender_email or ""):
        errors.append("Sender email address is missing or invalid")
    if not ex.line_items:
        errors.append("No line items found in the email body or attachment")
    missing = [FIELD_LABELS.get(f, f) for f in get_settings().required_enquiry_fields if not getattr(ex, f, None)]
    if missing:
        errors.append(f"Missing mandatory field(s): {', '.join(missing)}")

    seen: dict[str, int] = {}
    for li in ex.line_items:
        label = f"Line {li.line_no}"
        if not (li.sku or li.name):
            errors.append(f"{label}: no item code or item name")
        if li.quantity is None:
            shown = f" ('{li.quantity_raw}')" if li.quantity_raw else ""
            errors.append(f"{label}: quantity missing or not a number{shown}")
        elif li.quantity <= 0:
            errors.append(f"{label}: quantity must be greater than 0 (got {li.quantity:g})")
        if li.customer_rate is not None and li.customer_rate < 0:
            errors.append(f"{label}: negative unit price")
        if not li.unit:
            warnings.append(f"{label}: no unit of measure given — the Zoho item's unit will be used")
        key = (li.sku or li.name or "").strip().lower()
        if key and key in seen:
            warnings.append(f"{label}: same item as line {seen[key]} — kept as separate lines")
        elif key:
            seen[key] = li.line_no

    if ex.required_by and ex.required_by < date.today():
        warnings.append(f"Required-by date {ex.required_by.isoformat()} is in the past")
    if not ex.reference:
        warnings.append("No customer reference / RFQ number found")
    return ValidationResult(errors=errors, warnings=warnings)
