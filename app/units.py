"""Unit-of-measure normalisation, so 'NOS', 'EA' and 'PCS' compare equal but 'EA' vs 'MTR' is flagged."""
from __future__ import annotations

import re

UNIT_GROUPS: dict[str, set[str]] = {
    "piece": {"nos", "no", "number", "numbers", "pcs", "pc", "piece", "pieces", "ea", "each", "unit", "units", "qty"},
    "metre": {"m", "mtr", "mtrs", "meter", "meters", "metre", "metres", "rmt", "rm", "lm"},
    "kilogram": {"kg", "kgs", "kilogram", "kilograms"},
    "packet": {"pkt", "pkts", "packet", "packets", "pack", "packs", "pk"},
    "pair": {"pair", "pairs", "pr", "prs"},
    "set": {"set", "sets"},
    "roll": {"roll", "rolls"},
    "box": {"box", "boxes", "bx"},
    "litre": {"l", "ltr", "ltrs", "litre", "litres", "liter", "liters"},
    "lot": {"lot", "lots", "ls", "lumpsum"},
}


def unit_group(unit: str | None) -> str | None:
    """Canonical group for a unit ('EA' -> 'piece'); unknown units come back normalised as-is."""
    norm = re.sub(r"[^a-z]", "", (unit or "").lower())
    if not norm:
        return None
    return next((group for group, names in UNIT_GROUPS.items() if norm in names), norm)


def units_conflict(customer_unit: str | None, zoho_unit: str | None) -> bool:
    a, b = unit_group(customer_unit), unit_group(zoho_unit)
    return bool(a and b and a != b)
