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
- **What to do next**: "Customer not found in Zoho. Add this customer in Zoho Books. The email is being kept, and the quote is created automatically within a few minutes."
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

**Say:** "This answers the question every client asks: where is my data? Customers, prices and quotes stay in your own Zoho Books. On our server there is only a log of what happened, with no email text and no Excel files, deleted automatically after the number of days you choose. There is one exception: an email from a brand-new customer is kept for a few days, so the quote can be made automatically once you add them, and it is deleted as soon as that happens. And the text of an email is sent to Claude to be read, and our server doesn't keep it."

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

The client can send from **any address**. You do not need to know it beforehand, and you do not need to create them in Zoho. That is also how real life works: a customer's address is never known in advance, so the assistant finds the customer in three steps. First by the sender's exact email address, then by their company's email domain, then by the **company name written in the email**, usually the signature. (Free-mail domains such as gmail.com are never used for the domain step.)

For the demo, the easy way to a complete draft is for the client to write as one of your sample customers:

1. **They send to `yourname+rfq@gmail.com`** (not `yourname@gmail.com`). The assistant only acts on mail addressed to the `+rfq` address; mail to the plain address is left alone. A few corporate mail systems reject a "+" in an address; if theirs does, ask them to send from a personal address.
2. **The email names a customer that exists in your Zoho Books**, for example "Nellore Agro Exports" in the signature. Give them the ready-made email: the subject and text from `demo-emails/1-draft-ready/email.txt`. They send it from their own address. The dashboard then shows "matched by the company name in the email", which is the real behaviour for an unknown sender.
3. **The Excel uses items that exist in your catalogue.** Send them the Excel from the same folder to attach (`npm run demo:kit` makes fresh ones). Result: a complete priced draft. If you later let them attach **their own** Excel, the assistant reads their lines, but your catalogue won't contain their items, so every line is marked "manual pricing required". That honestly shows it reading a stranger's file and never inventing a price. Do the prepared file first, theirs second, and only if you have rehearsed it.

### A brand-new customer: the first email becomes a quote by itself

If the sender's company is not in Zoho Books yet, this is what happens, and it is worth showing:

1. **The email arrives** from the new customer. The assistant reads it but finds no matching customer.
2. **It does not lose the email.** It keeps it for a few days, and your team gets an alert: "Customer not found". On the dashboard it shows under "Needs you", with the plain instruction "Add this customer in Zoho Books. The email is being kept, and the quote is created automatically."
3. **Your team adds the customer in Zoho Books** (this is the human step: checking who they are, credit, GST). It takes a minute.
4. **Within about two minutes the draft quote appears by itself**, and the "Needs you" entry clears. Nobody asks the customer to resend anything, and the customer notices nothing.
5. **From then on,** the customer is in Zoho Books, so their next emails go straight to a draft.

So the first email from a new customer is not lost or delayed by a conversation: it is converted into a quote as soon as your team has approved the customer. If nobody adds the customer within the hold period (7 days by default), the kept email is deleted and the enquiry stays under "Needs you" for a person to follow up.

### Get the client set up in Zoho Books first, with their form (about 2 minutes of your time)

For a complete, priced draft on their very first email, their company and a few of their items must already be in your Zoho Books. You do not type them in by hand: the client fills in a small Excel form and one command adds everything.

1. **Make the form** and send it to the client with the message below:
   ```bash
   npm run onboard:template
   ```
   This writes `client-onboarding-template.xlsx` in the project folder.
2. **When they send it back, preview it.** Save their file in the project folder and run (it only reads, it changes nothing, and it says in plain words if something in the file needs fixing):
   ```bash
   npm run onboard -- their-file.xlsx
   ```
3. **Create everything in Zoho Books:**
   ```bash
   npm run onboard -- their-file.xlsx --create
   ```
4. **Restart the assistant** (Ctrl+C, then `npm start`) so it picks up the new items straight away.

Their Excel for the live email should use the same item names or codes as their form. Items already in Zoho are skipped, so running it twice is safe. The quote assistant itself never creates customers or items from emails, on purpose: a spam or fake email could otherwise fill your Zoho Books with junk. This is a deliberate step that you run.

### A message you can send them beforehand

> To set up your live demo, please fill in the attached form (your company name exactly as it appears at the bottom of your emails, and 3 to 5 items you often quote, with an approximate price) and send it back. Once it is loaded, during our call please send an email from your normal work address to **yourname+rfq@gmail.com**, with an Excel list that uses those items. You won't get a reply: the system never emails customers. We'll watch it appear on my screen. The text of the email is read by an AI service to understand it, and we keep only a short log of what happened (if your company is not set up yet, your email is kept for a few days so the quote can be made once it is). I'll delete the draft quote afterwards.

(Tell them about the AI reading and the draft up front. It is their data and their consent.)

### On the call

1. Share your screen: Gmail (your Inbox, where their email arrives), the dashboard, Zoho Books Quotes, and a second Gmail tab searching for `Quote agent` (the alerts).
2. Have the service running (`npm start`). It checks every minute.
3. They send. Their email arrives in your Inbox, unread (bold), with **their address** as the sender.
4. Within a minute: the dashboard shows their enquiry (sender: their address; customer: matched by company name), Zoho Books has the draft, and the alert email arrives in your Gmail (search `Quote agent`).
5. Say what you did not do: nothing was typed, and nothing was sent to them.

### Afterwards

Delete their draft in Zoho Books yourself, or tell me to (I only delete Zoho drafts when you say so). Stop the service. Their email text and Excel are not kept on this computer once the quote is made, only a short log.

### If it goes wrong live
- *Nothing appears after two minutes:* check the email was sent to the `+rfq` address and is unread, and that `npm start` is still running.
- *"Customer not found":* say "this is the safe behaviour: it does not guess", show the "Needs you" list, add the customer in Zoho Books, and watch the quote appear by itself within two minutes. That is the new-customer flow above.
- *They attach an old `.xls` file:* the assistant asks for a readable Excel instead of guessing. Ask them to resend as `.xlsx`.

---

## Everything else about the live set-up

`VIDEO_SCRIPT.md` has the short set-up (one app password, one command) and the recording guide.
- `npm run setup:gmail -- yourname@gmail.com` writes the settings and tests the connection. `npm run preflight -- --send` re-checks the mailbox, the alert-email login and Zoho Books before you start.
- `npm run demo:kit -- --check` makes four ready-to-send emails with Excel files and proves they behave as described.
- The mailbox settings in `.env` are still empty, so none of this has run live yet. Rehearse once yourself first.
