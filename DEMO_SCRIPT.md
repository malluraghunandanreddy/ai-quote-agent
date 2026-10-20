# Client demo script (about 25 minutes)

**The story:** a real customer email arrives, the agent reads it, a draft quotation appears in Zoho Books
ready for Sales to check and send, and every step is visible.

> Wording: the agent prepares a **draft quotation** (a Zoho "estimate"). Invoices are a later phase in the
> requirements (section 6: triggered by order confirmation, never automatic). Say "ready to send the quotation".

## The day before
- [ ] Live setup done:
  - Gemini **paid** key
  - Zoho Books connected, and demo items loaded (or, better, their real items with material codes as SKU)
  - Mailbox connected and admin password set
- [ ] **Full rehearsal** of every act below with real emails. Then **Reset demo**.
- [ ] Set `IMAP_POLL_SECONDS=15` (Setup isn't needed; edit `.env`), so arrivals show up in about 15 seconds,
      not 60. The ⚙ button's **Poll inbox** also fetches instantly.
- [ ] Prepare three emails as **drafts in Zoho Mail** (from userdemo2@ to userdemo2@), ready to send:
  1. **The real RFQ:** their Excel sheet attached, a short message with RFQ number, required-by date,
     delivery address and a phone number in the signature.
  2. **A messy one:** items typed in the email body (or a PDF RFQ), to show the AI reading free text.
  3. **A broken one:** an Excel with a quantity of 0 or "TBD", to show exception handling.
- [ ] Browser tabs: ① Quote Agent dashboard (**Presenter ON**), ② Zoho Mail inbox, ③ Zoho Books → Sales → Quotes.
- [ ] Backup plan: if internet or Zoho fails, ⚙ → samples run the same flow on demo data.

## The demo

**1. The problem (1 min).** "Today someone retypes each RFQ into Zoho: 30 lines, 30–60 minutes,
typos, missed items. Let's watch an enquiry go through on its own."

**2. An email arrives (3 min).**
- Tab ②: show email 1 (subject, RFQ no., delivery address, the Excel), then **Send**.
- Tab ①: the **"New quote request"** card pops up, and the pipeline lights up stage by stage:
  received → read → validated → customer → draft → Sales notified.

**3. How it was read (4 min).** Open the enquiry.
- *Overview:* customer, RFQ number, required-by date, delivery address and phone, picked out of the email by itself.
- *Source → result:* "Your Excel's columns (Material, Short text, Req. Qty…) → recognised as item code, name,
  quantity; each row → its Zoho line." This is the strongest moment, so stay on it.
- *Audit trail:* every step with its time; this is the processing log from the requirements.

**4. Matching and checks (4 min).** In the line items:
- **code match** with the Zoho price
- **verify match** (AI or fuzzy), with the reason
- **no price — not assumed:** "it never invents a price"
- **unit mismatch** (EA asked, sold per metre)
- **not in product master:** added as a line for Sales to price

**5. The draft in Zoho (3 min).** Click **Open in Zoho Books** (tab ③).
- The estimate is in **Draft**, with lines, quantities, prices, and notes (RFQ ref, delivery address, contact).
- "Sales fixes the flagged lines and sends it from Zoho. The agent never sends anything to your customer."
- Back in the dashboard, press **Approve**.

**6. The emails (2 min).** Tab ②:
- **"Draft Quotation Created – Demo Customer"**: quote number, total, item summary, flagged lines, link.
- **"New/Unmatched Products Identified"**: what stakeholders A, B and C receive.

**7. When things go wrong (3 min).**
- Send email 3. **"Additional Information Required"** goes to Sales, and the **Exceptions queue** shows "What to do".
- Send email 1 again. **Duplicate** is detected and no second quotation is made.
- Optionally send email 2 (free text or PDF): the AI reads the items.

**8. The numbers (2 min).** KPI tiles and charts: draft quotations, lines matched automatically, average
processing time, estimated effort saved, outcomes per day.

**9. Next steps (2 min).**
- A 2–4 week pilot on real enquiries.
- Their pricing, discount and GST rules, and the final mandatory fields.
- Go-live. Invoices come as phase 2.

## Don't
- Open **Setup** or turn Presenter off in front of the client.
- Promise 100% accuracy. Say: "it prepares about 90% of the work in seconds and points the person to the
  lines that need checking."
- Use the free Gemini tier with their real customer emails.

## Questions they'll ask
| Question | Answer |
|---|---|
| Where is our data? | On the server we run for you only (or yours), plus your own Zoho. Email text goes to Google Gemini only for reading, on the paid tier that isn't used for training. |
| Can it send quotes automatically? | Deliberately no. It drafts; your team approves and sends. |
| What if the Excel format changes? | Rules handle common layouts; the AI reads unfamiliar ones, PDFs and photos. |
| What does it cost to run? | Setup fee + monthly service. Google AI usage is billed directly to your own Google account, and Zoho API use is included in your Zoho plan. |
| Tally / other software later? | Same agent, different connector. |
