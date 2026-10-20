# Live demo setup — who does what, from which account

All values go into the project's `.env` file, and the easiest way is the dashboard's **Setup** page: pick the accounting system, paste keys and passwords, press **Save**, then **Test connections**. Never paste secrets into chat, email or tickets.

## Quick path with a single mailbox (quotes@demo.example.com)

One mailbox plays every role: the customer who sends the RFQ, the monitored inbox, the sales team that
gets the draft notification, and stakeholders A, B and C. Our own notification emails are tagged and
skipped by the inbox reader, so there's no loop.

**For the demo, send the RFQ from userdemo2@ to itself** (Zoho Mail → New mail → To: userdemo2@… →
attach the Excel). Mail inside your own Zoho org is delivered internally, so this should work even
before the missing MX record is fixed. Send yourself one test mail first to confirm. The DNS fix (4b)
is only needed when outside senders, such as a Gmail address, must reach the inbox.

**Your part (about 20 minutes, secrets typed only at hidden prompts):**
1. Gemini: open aistudio.google.com with any Google account (e.g. your own Gmail), click
   **Get API key → Create API key**, and copy it (section 1).
2. Zoho Books API: log in to api-console.zoho.in as the Books admin, create a Self Client, generate a
   code (scopes in section 2), then run `.venv/bin/python scripts/zoho_oauth_helper.py`.
3. Zoho Mail: as userdemo2@, turn on IMAP and create an app password (section 3).
4. Run `.venv/bin/python scripts/setup_secrets.py` and type the Gemini key and the app password.

**Then the assistant does the rest:** loads the demo customer and items into Zoho Books
(`scripts/seed_zoho_demo.py`, preview first, then `--apply` with your OK), runs the connection check,
does a live dry run, fixes anything Zoho rejects, and prepares presenter mode.

| # | What | Log in as | Must it be userdemo2@? | Goes into `.env` |
|---|---|---|---|---|
| 1 | Gemini API key | **Any** Google account: yours or the company's. The key belongs to a Google Cloud project, not to a mailbox | **No.** Use yours for the demo, and swap in another key later by editing one line | `GEMINI_API_KEY` |
| 2 | Zoho Books API (Self Client) | A Zoho user who is **Admin in the Zoho Books organization** where the drafts should appear | **No.** Any Books admin works. Drafts show as created by that user | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID` (written by the helper script) |
| 3 | Zoho Mail app password | **quotes@demo.example.com** itself | **Yes.** It's the inbox the agent reads and the address it sends from | `IMAP_PASSWORD`, `SMTP_PASSWORD` |
| 4 | IMAP permission + mail routing (DNS) | **example.com Zoho Mail super-admin** + whoever manages **GoDaddy DNS** for example.com | n/a | nothing |
| 5 | Customer + items in Zoho Books | Any Zoho Books user who can add customers/items | n/a | nothing |

---

## 1. Gemini API key (≈5 minutes)

1. Go to **aistudio.google.com** and sign in with any Google account (your own Gmail is fine).
2. Click **Get API key → Create API key**. Pick an existing Google Cloud project or let it create one.
3. Copy the key (it usually starts with `AIza`).
4. Run `.venv/bin/python scripts/setup_secrets.py` and type the key at the hidden prompt.
5. **Free tier vs paid.** The free tier needs no card and is enough for building and rehearsing, but it
   is rate-limited, and Google may use free-tier prompts and responses to improve its products. Since
   the demo sends real customer RFQs, turn on billing for the project (AI Studio → Billing) before
   using real customer data. Flash-model usage for a POC costs very little; check Google's pricing page.
6. The model is set by `GEMINI_MODEL` (default `gemini-3.8-flash`). To switch to another key or model
   later, change that line in `.env` and restart the server.

Claude remains available as an alternative: set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

## 2. Zoho Books API (≈15 minutes)

Do this logged in as a **Zoho Books admin** of the organization that should receive the drafts.

1. Open **https://api-console.zoho.in**. Use the `.in` domain because your Zoho is India-hosted; if the
   Books URL is `books.zoho.com`, use api-console.zoho.com and answer `com` in step 6.
2. **Get Started → Self Client → Create → OK.**
3. In the **Client Secret** tab, keep the Client ID and Client Secret at hand.
4. In the **Generate Code** tab:
   - Scope (paste exactly):
     `ZohoBooks.estimates.CREATE,ZohoBooks.estimates.READ,ZohoBooks.contacts.CREATE,ZohoBooks.contacts.READ,ZohoBooks.settings.CREATE,ZohoBooks.settings.READ`
     (the two CREATE scopes let `scripts/seed_zoho_demo.py` add the demo customer and items for you)
   - Time duration: **10 minutes**. Description: `Quote agent`.
   - Click **Create**. If asked, choose the Books organization. Copy the code.
5. Within 10 minutes, open a terminal in the project folder and run:
   ```bash
   .venv/bin/python scripts/zoho_oauth_helper.py
   ```
6. Answer the prompts: data centre `in`, Client ID, Client Secret (hidden), and code (hidden). Pick
   your organization from the list, then answer **Y** to write the values into `.env`.
   This also sets `ZOHO_MODE=live`.
7. If you see "invalid_code", the code expired or was already used. Generate a new one and rerun.

## 3. Zoho Mail app password for userdemo2@ (≈5 minutes)

Log in to Zoho as **quotes@demo.example.com**.

1. **Turn on IMAP:** mail.zoho.in → ⚙ Settings → **Mail Accounts** → select the address → **IMAP** →
   tick **IMAP Access** → Save.
2. **App password:** accounts.zoho.in → **Security** → **App Passwords** → **Generate New Password**,
   name it `Quote Agent`, and copy it.
   - If two-factor authentication is on, an app password is required. If it's off, the normal
     password works too, but an app password is safer and can be revoked on its own.
3. Run `.venv/bin/python scripts/setup_secrets.py` and type it at the hidden prompt. It fills **both**
   `IMAP_PASSWORD` and `SMTP_PASSWORD`.
   Hosts are already set: `imappro.zoho.in:993` and `smtppro.zoho.in:465`.
4. If login fails with "IMAP disabled by admin", do step 4a.

## 4. Admin tasks (super-admin + DNS owner)

**4a. Allow IMAP for the user.** mailadmin.zoho.in → **Users** → userdemo2 → Mail settings / access →
allow **IMAP** (and SMTP).

**4b. Fix mail routing (current blocker).** DNS for `demo.example.com` has **no MX record**, so
mail from outside to quotes@demo.example.com bounces.

1. mailadmin.zoho.in → **Domains** → `demo.example.com`. Add and verify it if it isn't listed,
   then open **Email Configuration** to see the exact records Zoho wants.
2. In **GoDaddy → example.com → DNS**, add these records, each with host **`demo2`**:
   - MX `mx.zoho.in`, priority 10
   - MX `mx2.zoho.in`, priority 20
   - MX `mx3.zoho.in`, priority 50
   - TXT (SPF) `v=spf1 include:zoho.in ~all`
   - The DKIM TXT record shown in Zoho admin (Domains → Email Authentication → DKIM)
3. Wait for DNS to propagate (minutes to a few hours), then send a test email from Gmail to
   quotes@demo.example.com.

Alternative if DNS can't be changed in time: use an existing `@example.com` mailbox and update
`MONITORED_INBOX`, `SALES_TEAM_EMAIL`, `IMAP_USER`, `SMTP_USER` and `SMTP_FROM` in `.env`.

## 5. Zoho Books demo data (≈15 minutes by hand, or 1 minute with the script)

**Automatic:** `.venv/bin/python scripts/seed_zoho_demo.py` shows what it would create; add `--apply` to
create the customer and 12 items. GST-registered orgs may need `--gst-treatment`, `--place-of-supply`
and `--hsn` (the script tells you if so). **By hand:**

1. **Customer:** Books → Sales → Customers → **New**.
   - Display name `Demo Customer Pvt Ltd`, primary contact email **quotes@demo.example.com**.
   - If your organization is GST-registered: GST treatment and place of supply (e.g. Andhra Pradesh).
2. **Items** (Books → Items → New). Add 8–12 items from `samples/electrical_tail_spend.xlsx`.
   `data/mock_zoho_catalog.json` has a ready-made list with names and prices.
   - For **some** items, set the **SKU = customer material code** (e.g. `1300077549`) to show exact
     matches.
   - Give **others** your own wording (e.g. "Eaton 9E 3kVA Online UPS") to show AI matching.
   - Set the unit and selling price. If GST-registered: HSN code + tax preference.
3. Leave the remaining sheet items out on purpose. They become "not in catalogue — price to be
   confirmed" lines, which demonstrates the review flow.

## 6. Final check (the day before the demo)

1. Restart the server, then run `.venv/bin/python scripts/check_connections.py`. All four live
   checks should show ✅. The same check is on the dashboard under **Go-live readiness**.
2. Dashboard → **Customer RFQ + Excel** sample, then open the draft in Zoho Books. Confirm its
   status is **Draft** and that nothing was emailed to the customer.
3. From Gmail, send the Excel file to quotes@demo.example.com and watch it appear within
   60 seconds.
4. Press **Reset demo**, then turn on **Presenter** (top-right) before the audience joins. New emails
   then open automatically, and the ⚙ button at bottom-left holds the samples as a backup.
5. Decide: the unmatched-items policy (`UNMATCHED_ITEM_POLICY`) and the real stakeholder addresses
   (`ALERT_RECIPIENTS`).
