# Plug-and-play connectors

The agent has three plug-in points. Each is chosen with one setting, from the dashboard's **Setup** page or `.env`:

| Plug-in point | Setting | Available now | Add next |
|---|---|---|---|
| Accounting / ERP | `ERP_CONNECTOR` | `zoho_books`, `standalone` (no software: PDF + Excel quotes by email), `webhook` (Zapier / Make / n8n / custom), `mock` (demo) | Tally, FreshBooks, QuickBooks Online, Xero, Odoo, SAP Business One |
| AI | `AI_PROVIDER` | `gemini`, `anthropic`, `openai` (any OpenAI-compatible API: OpenAI, Azure OpenAI, Groq, DeepSeek, Mistral, local Ollama …) | — |
| Email | `IMAP_*` / `SMTP_*` | Any IMAP/SMTP mailbox: Zoho Mail, Gmail (app password), most hosts | Microsoft 365 via Graph (password logins are blocked there) |

The core pipeline (`app/pipeline.py`) only talks to the connector interface, so adding a system never changes
how emails are read, validated, matched, flagged, retried or notified.

## The connector contract (`app/connectors/base.py`)

| Method | Must | Notes |
|---|---|---|
| `readiness()` | ✓ | Instant config check → `(ok, detail, how_to_fix)`; shown on the dashboard |
| `check()` | ✓ | Read-only live test (e.g. list organizations); used by *Test connections* |
| `find_customer(*emails, name=)` | ✓ | Customer master lookup: email first, then exact name |
| `get_items()` | ✓ | Active products with standard price and unit |
| `create_draft_quote(DraftQuote)` | ✓ | Create the quotation **as a draft**; never email or send it |
| `price_for(customer, item, qty)` | optional | Customer price lists / discounts / contract prices (default: item rate) |
| `find_existing_quote(customer_id, reference)` | optional | Duplicate guard used before re-creating on a retry |

Class attributes: `key`, `name`, `quote_label` (what the system calls a quote), `supports_unlinked_lines`
(can a line exist without a product link?), `is_mock`.

Raise `ConnectorError(message, status=…)` on failure. Network errors, HTTP 429 and 5xx are **retried
automatically**; validation errors (4xx) alert the team immediately.

### Adding a system in four steps
1. Create `app/connectors/<system>.py` with a `Connector` subclass (copy `zoho_books.py` as a template).
2. Register it with one line in `CONNECTORS` in `app/connectors/__init__.py`.
3. List its settings in `ERP_FIELDS` in `app/setup.py`, so they appear on the Setup page.
4. Add a test like `test_zoho_books_connector_against_fake_api` in `tests/test_connectors.py` (a fake HTTP
   server and no real account needed), then verify once against a live sandbox account.

## Recipes for the next connectors

These map the contract onto each system's documented API. Each needs a test account to verify before
production use.

**Tally (TallyPrime).** Integration is XML over HTTP on the Tally machine: enable *TallyPrime as server*,
default port 9000.
- Customers: export the `Ledger` collection under *Sundry Debtors* (name, email, phone).
- Products: export the `StockItem` collection (name, aliases or part numbers as codes, base unit, standard selling price).
- Draft: import a `VOUCHER` of type *Quotation* (or *Sales Order*) with `ISOPTIONAL=Yes`, so it doesn't touch the books until regularised.
- Because Tally runs on a local PC, deploy the agent (or a small relay) on the same network.

**FreshBooks.** OAuth 2.0 app.
- Customers: `GET /accounting/account/{accountId}/users/clients` filtered by email.
- Products: `…/items/items`.
- Draft: `POST …/estimates/estimates` with lines (name, quantity, unit cost), left as a draft estimate and not sent.

**QuickBooks Online.** OAuth 2.0 app (Intuit developer).
- Customers: `query: select * from Customer where PrimaryEmailAddr = '…'`.
- Products: `select * from Item`.
- Draft: `POST /v3/company/{realmId}/estimate` with `TxnStatus: Pending` and `EmailStatus: NotSet`, so it isn't emailed.

**Xero.** OAuth 2.0 app.
- Customers: `GET /Contacts?where=EmailAddress=="…"`.
- Products: `GET /Items`.
- Draft: `PUT/POST /Quotes` with `Status: DRAFT`.

**Odoo.** JSON-RPC with an API key.
- Customers: `res.partner` search by email.
- Products: `product.product`.
- Draft: create a `sale.order` in state `draft`, which Odoo shows as a *Quotation*.

**SAP Business One.** Service Layer REST.
- Customers: `BusinessPartners` (filter by email).
- Products: `Items`.
- Draft: `POST /Quotations`, or `Drafts` with `DocObjectCode: oQuotations` for a true draft.

**Systems with no API (Busy, Marg, spreadsheets).** Use `standalone`. Every quotation is also appended to
`quotes/quote_lines.csv`, ready to import, or use `webhook` with an integration platform.

## Email: Microsoft 365

Exchange Online blocks IMAP password logins, so Microsoft 365 mailboxes need an Azure app registration and the
Graph API (`/me/mailFolders/inbox/messages` to read, `/sendMail` to send). The inbox reader (`app/inbox.py`) and
the sender (`app/notifier.py: _smtp_send`) are the only two places that change.
