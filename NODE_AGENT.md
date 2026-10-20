# AI Quote Creation Agent: Node / TypeScript

Turns customer RFQ emails (free text + an Excel attachment) into **DRAFT quotations in Zoho Books**. Nothing is ever
sent to the customer. The Python app in `app/` is a separate implementation; this one lives in `src/`.

## How the work is split

| Claude (language only) | Deterministic code (everything that touches a number or a record) |
|---|---|
| Company, contact, delivery and notes from an ambiguous email body / signature | Row-by-row Excel extraction, number cleaning (`"1,200 Nos"` -> 1200), unit mapping |
| Picks column indexes when the header rules fail (checked against the real data before use) | SHA-256 hashing, atomic de-duplication in SQLite |
| Words the lead paragraph of exception emails (its figures are checked against the facts) | Customer match (email -> domain -> company), item match (SKU -> exact name), draft creation, GST via Zoho |

## Setup

```bash
npm install
cp -n .env.example .env        # fill in the Node section at the bottom; shared IMAP_/SMTP_/ZOHO_ values are reused
npm run test:mock              # end-to-end run (offline stand-in unless ZOHO_* are set), prints the quote link
npm test                       # unit tests
npm run seed:zoho              # WRITES sample customers + items into your Zoho org (idempotent, all marked SAMPLE)
npm run test:emails            # 13 deliberately messy emails -> Claude extraction -> customer match (read-only)
npm run test:emails -- --create   # same, then the full pipeline: reads each Excel and creates DRAFT quotes
npm run process-now            # one mailbox cycle, then exit
npm start                      # poll every 2 minutes (POLL_CRON)
npm run build && npm run start:prod
```

Minimum for a real run: `IMAP_HOST/USER/PASSWORD`, `ZOHO_DC/CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/ORGANIZATION_ID`,
`SMTP_HOST` (+ user/password), `ANTHROPIC_API_KEY` (optional: without a key the rules-only fallbacks run; the model is `claude-haiku-5-5`).
Without `SMTP_HOST` notification emails are written to the log and **not** delivered.

Do not run this agent and the Python app against the same mailbox at the same time.

## Flow (`src/workflow/processor.ts`)

1. Fetch unread mail with `BODY.PEEK` (reading never sets `\Seen`).
2. Per Excel attachment, **claim it in SQLite first** (atomic). Nothing with side effects runs before that.
3. Extract email metadata (Claude, or heuristics) from the newest message only (reply/forward history is stripped).
4. Parse the Excel; find the header in the first 5 rows; fall back to Claude for column indexes only if needed.
5. Resolve the customer (3 tiers: exact email asked live; domain and company name matched in code against a cached list of active
   customers, reloaded once on a miss so a customer created minutes ago is found). Not found / ambiguous -> `HALTED_CUSTOMER_NOT_FOUND` / `_AMBIGUOUS`, email Sales, no quote.
6. Match items. Unmatched lines are kept as unlinked lines at rate 0.00 with the description
   `[UNMATCHED ITEM - MANUAL PRICING REQUIRED]`; the quote is still created.
7. Create the estimate as a draft (idempotent via `reference_number`), verify Zoho reports `draft`.
8. Notifications A / B / C (each at most once per enquiry, even across retries).
9. Only now is the email flagged `\Seen` (and moved, if `IMAP_PROCESSED_FOLDER` is set).

Failures are recorded as `FAILED`, the email stays unread, and the next poll retries (up to `MAX_ATTEMPTS`, then the team is alerted).

## Interpretations worth knowing

- **De-duplication has two levels.** `sha256(excel + sender + message-id)` makes one delivery idempotent. Because the
  message-id differs on every email, "the same enquiry again within 48 h" is detected by `sha256(excel + sender)`.
  Both hashes are over the raw bytes, so a workbook re-saved in Excel (new metadata) counts as a new file.
  Halted / needs-info / failed enquiries do not block a re-send, so fixing the cause and re-sending works.
- **Column fallback trigger.** Claude is asked only when no quantity column is found, or neither a code nor a description column is.
  A sheet with description + quantity but no SKU is valid and is matched by name.
- **Extra header patterns.** Besides your alias lists, regexes accept common spellings (`Req. Qty`, `Material`, `Short text`,
  `Qty (Nos)`, `Unit of Measure`). The bundled `sample-rfq.xlsx` uses such headers.
- **Drafts.** Zoho creates estimates as drafts; the agent does not send a `status` field. It verifies the response says `draft`,
  and it never calls any send / email / status endpoint.
- **Pricing.** Matched lines are sent without a rate so Zoho applies the item master / customer price list. Set
  `ZOHO_SEND_ITEM_RATE=true` to send the item master rate instead. After creation, matched items that Zoho priced at 0.00 are
  reported with the unmatched ones (Notification B).
- **Unreadable rows.** If some rows cannot be read (e.g. quantity `approx 10`) the quote is still created from the readable rows
  and Notification A lists the rest. Negative / zero quantities and totals rows are ignored.
- **Quote notes.** Delivery timeline and special notes (extracted from the email) are written to the draft's `notes` field,
  prefixed `Enquiry (verify before sending)`. They are customer-visible on the PDF, so review before sending.
- **Claude settings.** Anthropic only. `ANTHROPIC_MODEL` (default `claude-haiku-5-5`), `ANTHROPIC_EFFORT` (default `low`: these are short
  extraction jobs), structured outputs (`output_config.format` from the Zod schema), adaptive thinking left at the model default, and SDK retries
  (`AI_MAX_RETRIES`, default 2) for 429 / 5xx / overloaded. Every reply is re-validated with Zod; a refusal, truncation, bad JSON, or API error
  falls back to the heuristics / the standard sentence. `AI_PROVIDER`, `GEMINI_*`, `AI_MODEL` and `AI_EFFORT` in a shared `.env` belong to the
  Python app and are ignored here.
- **`npm run test:mock` and live Zoho.** If `ZOHO_*` are set it talks to your real Zoho Books org. With the default fake sender
  (`purchase@acme-industries.co.in`) it only reads: the customer is not found and it halts before writing anything. To create a real
  draft, set `SAMPLE_SENDER_EMAIL=<an existing customer's email>`; re-running reuses the same draft (fixed reference number).

## What has and has not been run against live services

- **Zoho** reads (token refresh, customer and item lookups) have been run live against your org; sample customers and items were created there.
- **Claude Haiku 5.5:** covered by unit tests with the HTTP stubbed (exact request shape, refusal / truncation / bad-JSON fallbacks). The first live
  run needs `ANTHROPIC_API_KEY` in `.env`. (An earlier version of this layer ran live against Claude; that code has been removed.)
- **Not yet live:** IMAP polling, SMTP delivery, and Zoho **writes** (draft creation). Zoho details to confirm on the first live draft:
  `reference_number` on `/estimates`, `sku` / `status` fields on `/items`, and that an estimate without a line `rate` is priced by Zoho
  (else set `ZOHO_SEND_ITEM_RATE=true`).

## Model calls: what they cost and how few there are

Measured on the 13 messy emails with `claude-haiku-5-5` at `low` effort: **15 calls, 14.7k tokens in / 1.3k out, about $0.002 in total,
about 2 s per call**. Reading one email costs roughly **$0.00014** (about 940 tokens in, 90 out); at 1,000 emails a day that is about $0.15.
`LOG_LEVEL=debug` shows every call's token usage, and each polling cycle logs a "Model usage this cycle" line with calls, tokens and an
estimated cost.

What keeps it that low:
- **Deterministic first.** The Excel is parsed *before* any model call, so mail that cannot become a quote (no attachment, unreadable file,
  no readable rows) costs nothing; duplicates are rejected before parsing. A quotable email costs one call to read its text; a second call
  happens only if the header rules cannot place the columns, or to word an exception email.
- **Short, fenced input.** Long emails keep the start and the end (the signature is at the end), not just the start.
- **Effort `low`**: these are short extraction jobs; the model emits about 90 output tokens, so there is no hidden thinking to trim.
- **Guardrails.** `LLM_MAX_CALLS_PER_HOUR` (default 600) switches to the rules-only path if a flood of mail arrives; `AI_TIMEOUT_MS`
  (30 s) bounds a stuck call; the SDK retries 429 / 5xx / overloaded twice.
- **Not applicable here, on purpose:** prompt caching (our prompts are ~300-450 tokens, under the 512-token minimum, and the saving would be
  fractions of a cent) and the Batch API (emails are handled as they arrive).

Hostile text: an email that addresses the AI ("ignore previous instructions ...") is flagged, no free-text notes are taken from it, and Sales
gets a warning on the draft notification. The model only ever fills five short fields; names are matched against Zoho in code and
quantities, codes and prices never come from the model.

## Sample data and the messy-email check

`test/sampleData.ts` defines 12 fictional Andhra Pradesh customers, each messy in a different way (ALL CAPS, `M/s.` prefix, `(P) Ltd.`,
stray spaces, plus-addressing, mixed-case email, subdomain email, twins sharing a domain, free-mail owners ...). `npm run seed:zoho`
creates them and 12 sample items (SKU = material numbers from `sample-rfq.xlsx`) in your Zoho org.

`npm run test:emails` builds 13 messy emails (shouting, terse, a PA's forward, reply history naming another company, a prompt-injection
attempt, Telugu/Hinglish, HTML-only with disclaimer, a misspelt company, ...). Each carries **its own messy Excel layout**
(`test/sampleExcels.ts`: title blocks, repeated headers, footers, `1,200 Nos` / `12,00,000` quantities, formulas, padded codes,
cover and hidden sheets, header on row 5, misspelt headers, a price column next to the quantity, an injected instruction in a cell ...)
with the exact lines a correct reading must produce. For each email it checks what Claude extracted, which customer matched, what
the Excel yielded, and how many lines match your item master. It is read-only unless you pass `--create`, which also runs the full
pipeline and creates a DRAFT quotation for every email that resolves to a customer. Two layouts (#06, #11) can only be read with
Claude's column mapper; they are skipped when Claude is off or out of quota.

Known by design: a **misspelt** company name from a free-mail sender is *not* guessed (it halts and asks Sales), because attaching a
quote to the wrong customer is worse than asking.

**Zoho orgs that are not GST-registered** reject `place_of_contact`; customers are then created without a Place of Supply, quotes carry
no tax, and the "no Place of Supply" warning is suppressed.

