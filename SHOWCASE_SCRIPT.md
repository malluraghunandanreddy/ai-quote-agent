# Showcase script: the quote assistant and its dashboard

About 20 minutes with questions. A 10-minute version is at the end. Everything in the dashboard during this script is **sample data** (a ribbon at the top says so); say that in the first minute.

*(The older `DEMO_SCRIPT.md` in this folder is for the first Python version and does not match this dashboard.)*

---

## Before the meeting (15 minutes ahead)

1. In the project folder run:
   ```bash
   npm run demo
   ```
   Leave that window open. It builds a fresh month of sample enquiries each time, so run it again any time you want a clean start (notes you add during the demo disappear).
2. Open **http://localhost:3000** in the browser you will present from. If the port is busy: `DASHBOARD_PORT=3060 npm run demo`.
3. Open a second tab on your **Zoho Books → Sales → Quotes** page, signed in, with the draft quotes visible. This is the "real thing" you show at the end.
4. Window full-screen, zoom 100%, notifications off, laptop on power (and not sleeping).
5. Sign-in names (all use the password `showcase-demo-2026`, but the sign-in page has one-click buttons so you never type it):

   | Button | Person | Role |
   |---|---|---|
   | Owner · Meera | Meera Reddy | Owner |
   | Manager · Karthik | Karthik Rao | Manager |
   | Staff · Anita | Anita Sharma | Staff |
   | Viewer · Suresh | Suresh Iyer | Viewer |

**To show the client's own name and logo instead** (get their logo file first, ideally an SVG or PNG about 30 px tall):

```bash
BRAND_NAME="Acme Quotes" BRAND_LOGO=branding/sample-logo.svg BRAND_LOGO_ONLY=true BRAND_COLOR="#0f7b6c" BRAND_FOOTER="Powered by Your Company" npm run demo
```

Replace the logo path, name and colour with theirs.

**What's on the overview by default:** the time saved, the rupee value of that time (at the example rate), and what's waiting in drafts. The AI's own cost is hidden unless `SHOW_AI_COST=true`, because it is your cost, not the client's.

**The numbers change from day to day** (the sample data is built around today's date, and weekends are quieter). Read the figures off the screen; the ones below are examples.

---

## The story in one sentence

> "A customer emails an Excel list. The assistant reads the email and the Excel, finds the customer in Zoho Books, and creates a **draft** quote. Nobody has to type it. Nothing is ever sent to the customer, and your team can see exactly what happened to every email."

---

## 1. Opening (1 minute)

**Say:** "What you're about to see is sample data, so no real customer information is on screen. It's the same screens your team would use, with a month of made-up enquiries."

**Click:** the sign-in page is already showing. Point at the four buttons.

**Say:** "People sign in with their own email and password. For today I've put one-click buttons here, so I can show you what each kind of person sees. I'll start as the owner."

**Click:** **Owner · Meera**.

## 2. The overview: what a manager sees first (3 minutes)

**Point at** the big number (for example *5h 20m*).

**Say:** "This is the first thing: how much typing time the assistant saved in the last 7 days. It assumes about ten minutes per enquiry plus two per line item, and we set those to match how long your team really takes. So you can judge the saving yourself instead of taking our word for it."

**Point at** the two small chips under it.

**Say:** "The first turns those hours into money, at an hourly cost we set to your own staff's figure. The screen always says which rate it used, so nobody mistakes it for a measurement. The second is the total value of quotes now waiting in Zoho Books."

> **Presenter note:** the rupee figure in this demo uses an *example* rate of ₹300 an hour and made-up volumes, so don't present it as a promise. In the pilot we replace it with their real hourly cost and their real volume. At the sample volume the rupee saving per week is modest (around ₹1,600); if it looks small to them, lead with what hours alone don't show: a quote ready in minutes instead of hours, no typing mistakes, and no enquiry left sitting unanswered.

**Point at** the 14-day chart on the right. **Hover** a bar.

**Say:** "Blue is draft quotes created each day. The small red part is enquiries that needed a person. Quiet days are weekends."

**Click:** **Last 30 days** in the row of range buttons, then back to **Last 7 days**.

**Point at** the four numbers (Enquiries received, Draft quotes created, Drafts with items to price, Need a person).

**Say:** "These compare with the week before, so you can see at a glance whether things are busier or quieter."

## 3. From inbox to draft: where emails drop out (2 minutes)

**Scroll** to **From inbox to draft**.

**Say:** "Every email goes through the same five steps: received, Excel read, customer matched, draft created, fully priced. The drop-off under each step says in plain words what stopped. For example, senders not found in Zoho, or drafts with items that still need a price."

**Click:** **Customer matched**. It opens the list of enquiries that need a person. Use the browser's back button to return.

## 4. Needs you: the assistant knows its limits (3 minutes)

**Scroll** to **Needs you**.

**Say:** "These are the emails the assistant would not guess about. It never invents a customer. If someone writes in from a company that isn't in Zoho Books, it stops and tells your team what to do."

**Click:** the first item (a customer-not-found one).

On the enquiry page, **point at**, in order:
- **What to do next**: "Customer not found in Zoho. Create it, then ask the sender to resend."
- **What the assistant did**, on the right: "Step by step, in order. Nothing is hidden. If a customer ever asks 'what happened to my email?', you can answer in ten seconds."

**Say:** "The 'Team notes' box is for your people. I'll come back to it, because it's where the different roles matter."

## 5. A draft that needs pricing, and a quote to double-check (2 minutes)

**Click:** **Enquiries** in the top menu, then the tab **Items to price**. Open the first one.

**Point at:** "Lines: 6 read · 5 priced · 1 to price".

**Say:** "Where an item isn't in your catalogue, the assistant still adds the line to the draft, clearly marked 'manual pricing required', and tells your sales team. It does not make up a price."

**Click:** **Enquiries**, then the tab **Check before sending**. Open the quote in it (a **Large total** of around ₹13 lakh).

**Point at:** **Please check before sending**.

**Say:** "If a quote total or quantity is unusually large, the assistant flags it. A typo like an extra zero gets caught before the quote goes out. You choose the limits."

## 6. The people: different roles, different views (5 minutes)

**Say:** "Now the part managers ask about first: who can see and do what."

**Click:** **Team** in the menu.

**Point at** the people list, then scroll to **What each role can do**.

**Say:** "Four roles. Viewer just looks. Staff work the enquiries. Manager looks after the desk and the team. Owner runs the account. Higher roles manage the ones below them. A manager cannot touch an owner. And there is always at least one owner, so nobody can lock the account by accident."

**Click:** **Add a person**. Enter a made-up name, the email `new.person@acme.example`, role **Staff**, and **Add and show the first password**.

**Say:** "The new person gets a one-time password, shown once, to hand over in person or by phone. They have to choose their own the first time they sign in. Nobody ever sees anyone else's password."

**Click:** **Activity** in the menu.

**Say:** "Only owners see this. Every sign-in, every change to access, every note and every download is recorded with who did it. It's the answer to 'who changed that?'"

**Click:** **Sign out** (top right), then **Staff · Anita**.

**Say:** "Now I'm Anita, one of your sales staff. Look at the menu: no Team, no Status, no Activity."

**Click:** the same enquiry that needed a person (from the **Needs you** box on the Overview). In **Team notes**, type "Called them, will add them in Zoho today" and click **Save note**, then **Mark as handled**.

**Click:** **Overview**.

**Say:** "The item is gone from 'Needs you', and a line says your team marked it handled. If I open that enquiry, her name and her note are on it."

**Click:** **Sign out**, then **Viewer · Suresh**.

**Say:** "And this is a director who just wants to look. Overview, enquiries, and that's all."

**Click:** the browser's address bar, type `localhost:3000/team` and press Enter. You'll see "Not available for your role".

**Say:** "Even if he types the address in, the system says no, politely, and records the attempt."

**Click:** **Sign out**, then **Manager · Karthik**. Open **Status** in the menu.

**Say:** "A manager also sees the health of the system and can download the enquiry list."

## 7. Status and where the data lives (2 minutes)

On **Status** (as Karthik): **point at** Mailbox, Zoho Books, Claude, Alert emails, Daily backup.

**Say:** "This is the control panel in plain English: is the mailbox being checked, is Zoho connected, did last night's backup finish. If the mailbox stops being checked, the team gets an email, and the dashboard shows a red banner."

**Click:** **Your data** in the menu.

**Say:** "This answers the question every client asks: where is my data? Customers, prices and quotes stay in your own Zoho Books. On our server there is only a log of what happened, with no email text and no Excel files, deleted automatically after the number of days you choose. And the text of an email is sent to Claude to be read, and our server doesn't keep it."

## 8. The real thing: Zoho Books (2 minutes)

**Switch** to the Zoho Books Quotes tab.

**Say:** "This is what your team sees in the tool they already use. The quotes the assistant made are drafts. Your team reviews them and sends them as usual. Nothing goes to a customer unless a person sends it."

**Be clear:** these drafts came from our earlier test emails; the quote numbers in the demo dashboard (for example QT-000143) are made up and will not be in this list.

## 9. Closing (1 minute)

**Say:** "To recap: no typing, nothing guessed, nothing sent without a person, everything visible, and your own people with the right level of access. The next step is a pilot: we connect it to your mailbox and Zoho, run your real enquiries for a couple of weeks with every draft reviewed, and look at the numbers together."

---

## Questions you will probably get

| They ask | Say |
|---|---|
| Will it email my customers? | "No. It never emails customers. Alerts go only to your own staff, and quotes stay as drafts until a person sends them from Zoho Books." |
| What if the AI gets something wrong? | "Prices, quantities and totals are calculated by ordinary code, never by the AI. The AI only helps read the email text. Anything unusual is flagged, and every step is recorded." |
| What about messy emails and messy Excels? | "We tested 13 differently messy emails, each with a differently laid-out Excel, and it read all 13 correctly. If a new layout fails, it stops and asks a person rather than guessing." |
| What does the AI cost? | "Roughly one paisa per email on our tests, about $0.15 a day for a thousand emails." Say how your pricing treats it (included, or at cost). The dashboard does not show this figure unless you switch it on (`SHOW_AI_COST=true`). |
| We already use Zoho Books. What does this add? | "Zoho Books stays exactly where it is: it's still where every quote lives. What it doesn't do by itself is read an RFQ email and its Excel and build the quote. Today someone opens the email, finds the customer, and retypes every line. This takes over that typing. It also shows what happened to every email, including the ones that never became a quote, which Zoho can't show you because they never got that far." If they mention an import or automation tool, ask how much of their mail arrives clean enough for it; our test emails were deliberately messy. |
| Why show savings, and not just the quotes? | "Because the quotes are in Zoho, but the typing you *didn't* do leaves no trace anywhere. This is the only place that shows what the assistant is worth, in hours and rupees, so whoever approves the monthly fee can see it for themselves." |
| Where is our data? | Point at **Your data**. |
| Who can see what? | Point at **What each role can do** on the Team page. |
| Can it use our logo and name? | "Yes: name, logo, colour and a footer line, no changes to the software." (Show the branded run if you prepared it.) |
| Can we host it ourselves? | "Yes, either way. We can host and look after it for a monthly fee, or you run it on your own server and we support and update it." |
| What if it stops working? | "The team gets an email after a few failed checks, and another when it recovers. A health page shows the state, and nightly backups are kept." |
| Does it work with our Zoho (GST)? | "We've tested against a Zoho test organisation. Your own organisation, with its GST settings, is the first thing we check in the pilot." Do not say more than this. |

## Please do not say or promise

- Two-step sign-in, password reset by email, emailed invitations: **not built**.
- One screen to manage many clients: **not built** (each client has their own installation).
- That it has run on a real mailbox: **not yet**. The mailbox connection is the first step of the pilot.
- Quote numbers shown in the demo are made up. Do not click "QT-…" links expecting that exact quote to open.

## If something goes wrong

| Problem | Fix |
|---|---|
| Page won't load | In the window running the demo press Ctrl+C, run `npm run demo` again (about 10 seconds), refresh. |
| "Address already in use" | `DASHBOARD_PORT=3060 npm run demo` and open `http://localhost:3060`. |
| Sent back to the sign-in page | The demo was restarted. Click a role button again. |
| Numbers look odd | They depend on today's date; just read what's on screen. Stay on **Last 7 days** if **Today** looks quiet. |
| You added notes and want a clean start | Re-run `npm run demo`. |

---

## The 10-minute version

1. Opening (sample data, four buttons) → Owner · Meera.
2. Overview: the big number, the chart, the four numbers.
3. **Needs you** → open an item → "What the assistant did".
4. The flagged **Large total** quote.
5. Team page: role table → sign in as **Staff · Anita**, add a note, mark handled → **Viewer · Suresh**, point at the short menu.
6. **Your data**.
7. Zoho Books tab → closing line.

---

## Live, with the client sending their own email

You can ask the client to send an email from **their own address** during the call, and watch it turn into a draft on your screen. The sender's real mail ID shows up in the dashboard. Three things must be true beforehand, or the result will be less impressive:

1. **They send to the right address:** `yourname+rfq@gmail.com` (not `yourname@gmail.com`). The "+rfq" part makes Gmail file it under the `RFQ-Demo` label, which is the only place the assistant reads. If they send to the plain address instead, it lands in your Inbox and the assistant never sees it. Fix on the spot: open it in Gmail, apply the label `RFQ-Demo`, and mark it unread. A few corporate mail systems reject a "+" in an address; if theirs does, use that same fix, or add a Gmail filter beforehand for `from:@theirdomain.com` that applies `RFQ-Demo`.
2. **They exist as a customer in your Zoho Books.** Otherwise the honest result is "Customer not found" (no draft, an alert to your team). That is still a good thing to show, but it is not the draft you want to lead with. Before the call, ask for their company name and the address they will send from, and create a customer for them in Zoho Books (name, for example "Their Company (DEMO)", with that email as the contact email). The assistant then matches by sender email. I can create it for you if you tell me the details and say go ahead.
3. **The items in their Excel exist in your catalogue.** Send them one of the ready-made Excel files beforehand (`npm run demo:kit` makes fresh ones; the item codes in them exist in your Zoho). Result: a complete priced draft. If you then let them send **their own** Excel, the assistant reads their lines, but your catalogue won't contain their items, so every line is marked "manual pricing required". That honestly shows how it reads a stranger's file and never invents a price. Do the prepared file first, their own file second, and only if you have rehearsed it.

### A message you can send them beforehand

> Subject: Quick live test during our call
>
> During our call, please send an email from your normal work address to **yourname+rfq@gmail.com**. Write it like a normal quote request, with your company name in the signature, and attach the Excel (.xlsx) list I'm sending you. You won't get a reply: the system never emails customers. We'll watch it appear on my screen. The text of the email is read by an AI service to understand it, and we keep only a short log of what happened. I'll delete the draft quote afterwards.

(Tell them about the AI reading and the draft up front. It is their data and their consent.)

### On the call

1. Share your screen: Gmail on the `RFQ-Demo` label, the dashboard, Zoho Books Quotes, and Gmail on the `Quote agent` label.
2. Have the service running (`AGENT_DB_PATH=data/video.sqlite POLL_CRON='* * * * *' npm start`). It checks every minute. To skip the wait, run `AGENT_DB_PATH=data/video.sqlite npm run process-now` in a second window.
3. They send. Their email appears in `RFQ-Demo` in bold. If it is not bold, mark it unread.
4. Within a minute: the dashboard shows their enquiry (with **their address as the sender**), Zoho Books has the draft, and the alert lands under `Quote agent`.
5. Say what you did not do: nothing was typed, and nothing was sent to them.

### Afterwards

Delete their draft in Zoho Books yourself, or tell me to (I only delete Zoho drafts when you say so). Stop the service. Their email text and Excel are not stored on this computer, only the short log in `data/video.sqlite`.

### If it goes wrong live
- *Nothing appears after two minutes:* check the email is in `RFQ-Demo` and unread. Check `npm start` is still running.
- *"Customer not found":* say "this is the safe behaviour: it does not guess", show the "Needs you" list, then continue with the prepared example.
- *They attach an old `.xls` file:* the assistant asks for a readable Excel instead of guessing. Ask them to resend as `.xlsx`.

---

## Everything else about the live set-up

`VIDEO_SCRIPT.md` has the one-time Gmail set-up (labels, filters, app password), the exact `.env` settings, and the recording guide.
- `npm run preflight -- --send` checks the mailbox, the alert-email login and Zoho Books before you start.
- `npm run demo:kit -- --check` makes four ready-to-send emails with Excel files and proves they behave as described.
- The mailbox settings in `.env` are still empty, so none of this has run live yet. Rehearse once yourself first.
