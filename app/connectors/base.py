"""The ERP connector contract. The agent core talks only to this interface, so any accounting or ERP system
(Zoho Books, Tally, SAP Business One, QuickBooks, Odoo, plain files …) plugs in by implementing it.

To add a system: subclass `Connector`, implement the five abstract methods, register it in
`app/connectors/__init__.py`, and select it with ERP_CONNECTOR in .env. See CONNECTORS.md.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..schemas import CatalogItem, CustomerMatch, DraftQuote, PriceResult, QuoteResult


class ConnectorError(Exception):
    """Any failure talking to the ERP. `retryable` decides whether the agent schedules an automatic retry."""

    def __init__(self, message: str, status: int | None = None, code: int | str | None = None, retryable: bool | None = None):
        super().__init__(message)
        self.status, self.code = status, code
        self._retryable = retryable

    @property
    def retryable(self) -> bool:
        if self._retryable is not None:
            return self._retryable
        # Network errors, rate limits and server-side outages are worth retrying; validation errors are not.
        return self.status is None or self.status == 429 or self.status >= 500


class Connector(ABC):
    key: str = ""                        # value of ERP_CONNECTOR
    name: str = ""                       # shown in the dashboard and emails, e.g. "Zoho Books"
    quote_label: str = "quotation"       # what the ERP calls a quote ("estimate", "sales quotation" …)
    is_mock: bool = False                # demo data, not a real system
    supports_unlinked_lines: bool = True  # can a quote line exist without a product from the master?

    # --- configuration ----------------------------------------------------------------
    @abstractmethod
    def readiness(self) -> tuple[bool, str, str]:
        """(configured?, detail, how to fix) — instant, no network."""

    @abstractmethod
    async def check(self) -> str:
        """Read-only live connectivity test; raise ConnectorError on failure."""

    # --- masters ----------------------------------------------------------------------
    @abstractmethod
    async def find_customer(self, *emails: str | None, name: str | None = None) -> CustomerMatch | None:
        """Customer master lookup: by email(s) first, then by exact name."""

    @abstractmethod
    async def get_items(self) -> list[CatalogItem]:
        """The product master (active items) with standard selling price and unit."""

    async def price_for(self, customer: CustomerMatch, item: CatalogItem, quantity: float) -> PriceResult:
        """Customer-specific price. Default: the item's standard rate. Override to apply price lists,
        discounts or contract prices from the ERP."""
        return PriceResult(rate=item.rate or 0.0)

    # --- quotations -------------------------------------------------------------------
    @abstractmethod
    async def create_draft_quote(self, quote: DraftQuote) -> QuoteResult:
        """Create the quotation as a DRAFT. Must never email or otherwise send it to the customer."""

    async def find_existing_quote(self, customer_id: str, reference: str) -> QuoteResult | None:
        """Duplicate guard for retries: a draft this agent already created for customer + reference."""
        return None
