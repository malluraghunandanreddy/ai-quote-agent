# AI Quote Creation Agent

Reads customer enquiries from email (free text plus Excel, CSV, PDF, image or Word attachments), validates
them, matches the customer and products, and creates a **draft quotation that is never sent to the
customer**. It works with whatever the business uses, or with nothing at all. Sales get a notification,
stakeholders get alerts for anything that needs a person, and everything is visible in a live dashboard.

```
 Inbox (IMAP) / upload / samples
        │
        ▼
 EXTRACT ─► VALIDATE ─► CUSTOMER ─► PRODUCTS & PRICES ─► DRAFT QUOTATION ─► NOTIFY
 rules, then AI      mandatory  via connector  code → name → fuzzy → AI;     via connector:       A/B/C emails
 for PDFs, photos,   fields,                   flags: not found, no price,   Zoho Books, PDF,     + failure /
 odd layouts         quantities                uncertain match, unit         webhook …            customer alerts
                                               mismatch
        └──────── temporary failure → automatic retry · permanent → alert ───────┘   audit log → dashboard
```

## Plug and play

| Layer | Options | Chosen with |
|---|---|---|
| Accounting / ERP | **Zoho Books** · **No accounting software** (price list in Excel, PDF + Excel quote emailed) · **Webhook** (Zapier / Make / n8n / any system) · Demo | Setup page or `ERP_CONNECTOR` |
| AI | **Gemini** · **Claude** · **any OpenAI-compatible API** (OpenAI, Azure, Groq, DeepSeek, local Ollama) | Setup page or `AI_PROVIDER` |
| Email | Any IMAP/SMTP mailbox (Zoho Mail, Gmail, most hosts) | Setup page |

Tally, FreshBooks, QuickBooks, Xero, Odoo and SAP Business One plug into the same interface. See
**[CONNECTORS.md](CONNECTORS.md)** for the contract and a recipe for each.

## Quick start

```bash
uv venv --python 3.12 .venv            # or: python3.12 -m venv .venv
uv pip install --python .venv/bin/python -r requirements.txt
cp -n .env.example .env
.venv/bin/python scripts/make_samples.py
.venv/bin/python -m uvicorn app.main:app --port 8000
```

Open http://localhost:8000, click **Setup** to choose your accounting system, AI and mailbox (changes
apply without a restart), then try the samples on the right.

With Docker: `docker compose up -d`. The settings file, database, price list and generated quotes are kept
on a volume.

## Daily use
1. A customer emails the sales inbox. The agent picks it up within a minute.
2. A draft quotation appears in the accounting system, or as a PDF and Excel file in no-software mode.
3. Sales get **"Draft Quotation Created – Customer"** with the total, flagged lines and a link or attachments.
4. They review, then **Approve** or **Reject** in the dashboard, and send it from their own system.
   The agent never sends quotations.

## Emails (requirements section 3)

| Email | To | When |
|---|---|---|
| A · Additional Information Required – Customer Quotation | Sales | Mandatory fields missing, invalid quantities, unreadable attachment |
| B · New/Unmatched Products Identified – Quote Enquiry | Stakeholders A, B, C | Product not in the master, no price, or uncertain match |
| C · Draft Quotation Created – *Customer* | Sales | Every draft (quote number, customer, items, total, status, link) |
| Customer Review Required – Quote Enquiry | Sales | Sender doesn't match any customer |
| Quote Agent Processing Failure – *code* | Stakeholders | Permanent ERP error, or temporary error after all retries |

The agent recognises its own emails and skips them, so the inbox and Sales can be the same mailbox.

## Safety and correctness
- Drafts only. Zoho estimates are created with `send=false`, and no connector calls a send endpoint.
- **Prices are never guessed.** Products with no price stay at 0, are shown as *TBC*, and are flagged.
- Uncertain AI or fuzzy matches, unit mismatches (EA requested, sold per MTR) and products not in the
  master are flagged on the line, in the email, and on the dashboard.
- Duplicate emails don't create a second quotation, and a retry never duplicates a draft the ERP already
  created.
- AI calls are structured-output only, with no tools: content in an email can at worst produce a wrong draft
  that a person reviews.
- Dashboard login (`ADMIN_PASSWORD`). Secrets are never sent back to the browser.

## Tests

```bash
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/python -m pytest tests -q
```

31 tests cover extraction (including legacy .xls and Word), every pipeline scenario, the three spec emails,
all connectors (including a fake Zoho Books API), retries and the duplicate guard, login, setup and price-list
upload, and all three AI providers (including PDF input) against fake servers.

## Project structure

```
app/
  main.py            API, dashboard, login, setup, inbox poller, retry scheduler
  pipeline.py        the agent: extract → validate → customer → products & prices → draft → notify
  connectors/        plug-and-play ERPs: base.py (contract), zoho_books, standalone, webhook, mock
  ai.py              AI providers (gemini / anthropic / openai-compatible) + extraction jobs
  documents.py       PDF + Excel quotations (no-software and webhook modes)
  email_parser.py    .eml parsing, labelled fields, phone / delivery address, inline items
  excel_parser.py    header detection + synonyms (.xlsx/.xls/.csv); hands odd layouts to AI
  attachments.py     attachment types, Word text extraction
  validator.py, mapper.py, units.py   rules: mandatory fields, matching, unit groups
  notifier.py        emails A / B / C + failure / customer review, SMTP retry, attachments
  setup.py, auth.py, readiness.py, inbox.py, db.py, config.py, schemas.py
  static/            dashboard, setup page, login page
data/                demo catalogue, starter price list (data/standalone)
samples/             customer's sheet format + demo emails (Excel, PDF, free text …)
scripts/             zoho_oauth_helper, seed_zoho_demo, setup_secrets, check_connections, make_samples
tests/               pytest suite
```

## Configuration

Everything is on the Setup page, and `.env.example` documents each setting. Commonly used:
- `ERP_CONNECTOR` and `AI_PROVIDER`
- `UNMATCHED_ITEM_POLICY` (`free_text` adds unknown products to the draft for review; `exception` stops)
- `REQUIRED_ENQUIRY_FIELDS` (extra mandatory fields such as `delivery_address` or `contact_phone`)
- `RETRY_ATTEMPTS` / `RETRY_DELAY_SECONDS`
- `STANDALONE_TAX_PERCENT` and the `BUSINESS_*` fields printed on PDF quotes

Going live with real data: **[LIVE_DEMO_SETUP.md](LIVE_DEMO_SETUP.md)**.
