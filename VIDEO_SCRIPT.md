# Recording the end-to-end demo video (about 8 minutes)

**What the viewer sees:** a customer's email arrives from a real address with an Excel attached → the assistant reads it → finds the customer in Zoho Books → a **draft** quote appears → your team gets an alert email → the dashboard shows what happened → the awkward cases (an unknown item, an unknown customer, no attachment) are handled without guessing.

**Who records it:** you. I can't record a screen from here. QuickTime does it (Cmd+Shift+5). This Mac also has `ffmpeg`, so trimming, captions and compressing are one command each (end of this page). The kit below makes the recording a one-take job.

> **Not run on a real mailbox yet.** The mailbox and email-sending parts have never run against a live server. Do the setup and one full rehearsal (Part 1) before recording anything.

---

## Part 1: One-time setup (about 30 minutes)

### 1. Put the mailbox settings in `.env` (you do this; keep them out of chat and out of the video)

Five settings are still empty: `IMAP_HOST`, `IMAP_PASSWORD`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`.

The demo mailbox `quotes@demo.example.com` is hosted on **Zoho Mail India** (its mail records say so). The usual values:

| Setting | Value |
|---|---|
| `IMAP_HOST` | `imappro.zoho.in` (port 993, already set) |
| `SMTP_HOST` | `smtppro.zoho.in` (port 587, already set, `SMTP_STARTTLS=true`) |
| `SMTP_USER` | the mailbox address |
| `IMAP_PASSWORD`, `SMTP_PASSWORD` | the mailbox password, or an **app password** if the account uses two-step sign-in |

In Zoho Mail, IMAP access must be switched on (mail settings, IMAP access). App passwords are under Zoho Accounts, Security. If `imappro` refuses you, try `imap.zoho.in` and `smtp.zoho.in`, which personal accounts use.

### 2. Check it works, without processing anything

```bash
npm run preflight -- --send
```

It tests the mailbox login, the alert-email login and Zoho Books, sends one test message to your internal address, and lists any **unread** emails the assistant would pick up. Keep going until every line has a ✓. The messages say in plain words what is wrong if not.

### 3. Tidy the mailbox

Mark everything in the monitored inbox as read, so the video contains only the demo emails.

### 4. Use a separate inbox for the team's alerts (recommended)

Right now every alert goes to the same mailbox the assistant reads. That is safe (the assistant ignores its own alerts), but for the video it is clearer if the *customer's mailbox*, the *company RFQ mailbox* and the *team's alert inbox* are three different places. Set `NOTIFY_INTERNAL_EMAIL` and `EXCEPTION_STAKEHOLDERS` in `.env` to your own address. Alerts only ever go to these internal addresses, never to customers.

### 5. Pick the "customer" address

Any other mailbox you can send from (for example a Gmail). Its address is what the viewer sees as the sender. The ready-made emails name the company in the signature, so the assistant finds the customer by company name.

*Stronger shot (optional):* edit one sample customer in Zoho Books (for example Nellore Agro Exports) so its contact email is your "customer" address. The assistant then matches by **sender email**, its first and most reliable check, and the dashboard says so. You do this in Zoho yourself; I can also do it if you tell me the address and say go ahead.

### 6. Make fresh demo emails and check them

```bash
npm run demo:kit -- --check
```

This writes `demo-emails/` (four folders, each with an Excel file and an `email.txt` giving the subject and body) and runs all four through the real processing code against a read-only copy of your Zoho customers and items. All four should say PASS. It creates nothing in Zoho and sends nothing.

**Always make fresh files before each take.** The same Excel sent again from the same address within 48 hours is ignored as a duplicate, on purpose.

### 7. Start the service on a clean database

```bash
AGENT_DB_PATH=data/video.sqlite npm run users -- add you@yourcompany.com "Your Name" owner
```

It prints a one-time password. Then:

```bash
AGENT_DB_PATH=data/video.sqlite POLL_CRON='* * * * *' npm start
```

This checks the mailbox every minute and serves the dashboard at **http://localhost:3000** (stop `npm run demo` first if it is still running; they use the same port). Sign in once now and choose your own password, so the password-change screen is not in the video. A fresh database means the dashboard shows only your demo enquiries.

To skip the wait after sending an email, in another window run `AGENT_DB_PATH=data/video.sqlite npm run process-now`.

### 8. Do one full rehearsal

Send emails 1 to 4 (Part 3), watch each one arrive, and check Zoho Books and the alert inbox. Drafts created during rehearsal stay in Zoho Books. Look at them before deleting anything (I only delete Zoho drafts if you tell me to).

---

## Part 2: Screen set-up

- One browser window, full screen, **zoom 110 to 125%**, bookmarks bar hidden, notifications and Do Not Disturb on.
- Four tabs, in this order: **(1)** the customer's webmail, **(2)** the dashboard, **(3)** Zoho Books → Sales → Quotes, **(4)** the team's alert inbox.
- Never show `.env`, passwords or the terminal's settings. The terminal should be hidden or minimised.
- Record at 1080p with the microphone on, or record silent and add the narration later.

---

## Part 3: Shot list and narration

Times are targets. Cut out the waiting.

### Scene 1: The problem (0:00 to 0:30)
*On screen: the dashboard sign-in page, then the empty Overview.*

> "Every day your team gets quote requests by email, usually with an Excel list attached, in all sorts of layouts. Someone reads the email, finds the customer in Zoho Books, and types every line into a quote. This shows how that happens with no typing. Everything you'll see is the real system, not a mock-up."

### Scene 2: The customer's email (0:30 to 1:30)
*Tab 1. Compose in the "customer" mailbox using `demo-emails/1-draft-ready/email.txt`. Make the From address visible.*

> "Here's a customer, Anitha at Nellore Agro Exports, sending a request to your quotes mailbox. A normal email: a few lines, her company in the signature, and the list of items as an Excel file."

*Open the Excel for a moment.*

> "The list has item codes and quantities, laid out the way her company does it. Now she sends it."

*Click Send.*

### Scene 3: The assistant picks it up (1:30 to 2:00)
*Switch to the dashboard (tab 2). Show Overview. Cut the wait.*

> "Behind the scenes the assistant checks the mailbox every couple of minutes. It reads the email, reads the Excel, and works out who the customer is."

### Scene 4: What it found (2:00 to 3:15)
*Dashboard: the new row, then open the enquiry.*

> "There it is: Nellore Agro Exports, *Draft ready*, three of three lines priced."

*Point at From, Matched customer, and the timeline.*

> "Here's the sender's address, and the customer it matched in Zoho Books and how it matched. And this is the step-by-step record of what the assistant did, so nothing is hidden."

### Scene 5: The draft in Zoho Books (3:15 to 4:15)
*Click the quote link, or open tab 3.*

> "And here's the quote in Zoho Books: the right customer, the right items, prices from your own catalogue, and the status is *Draft*. It has not been sent to anyone. Your team reviews it and sends it as usual."

### Scene 6: The team is told (4:15 to 5:00)
*Tab 4: the alert email.*

> "Your team also gets a short email: draft created, for which customer, with the quote number. Only your own people ever get these. Customers are never emailed by the system."

### Scene 7: The awkward cases (5:00 to 6:30)
*Send `2-item-to-price` (loud ALL CAPS, one item not in the catalogue). Dashboard, Zoho, alert.*

> "Real emails aren't tidy. This one is shouting, and one of the items isn't in your catalogue. The assistant still makes the draft. The line it can't price is clearly marked 'manual pricing required', and your team gets a separate alert to price it. It never invents a price."

*Send `3-unknown-customer`. Dashboard "Needs you", then the alert.*

> "And here's a company that isn't in Zoho Books. The assistant does not guess and does not create customers. It stops, and tells your team what to do. That's the 'Needs you' list."

*(Optional, 15 seconds: send `4-no-attachment`.)*

> "And a one-line email from a phone with no attachment: it asks for the list instead of failing quietly."

### Scene 8: Control and trust (6:30 to 7:30)
*Team page, then sign in as the Viewer. Then Your data.*

> "Everyone signs in with their own login. A viewer only looks. Staff work the enquiries. Managers and owners also see the system and the team. Every sign-in and change is recorded. And this page answers where your data lives: customers, prices and quotes stay in your Zoho Books; here we keep only a log of what happened."

### Scene 9: The result and what's next (7:30 to 8:00)
*Overview: the time-saved figure.*

> "In this short run, the assistant built two quotes without anyone typing a line, and correctly handed the other two to your team instead of guessing. This number adds up the time saved, and in rupees at your own staff cost. The next step is a short pilot on your real mailbox, with every draft still reviewed by your team, and then we look at the numbers together."

---

## Part 4: Recording and finishing

- **If a take goes wrong:** stop the service, delete `data/video.sqlite*`, run `npm run demo:kit` for fresh files, restart, and go again. Quote numbers in Zoho Books keep counting up, and rehearsal drafts stay there until you decide.
- **Trim a recording:** QuickTime, Edit, Trim. Or: `ffmpeg -ss 00:00:05 -to 00:07:40 -i take.mov -c copy trimmed.mov`
- **Compress for sending** (a small file that plays everywhere): `ffmpeg -i take.mov -vf scale=1920:-2 -c:v libx264 -crf 24 -c:a aac demo.mp4`
- **Speed up a waiting stretch** (4x): `ffmpeg -i in.mov -filter:v "setpts=0.25*PTS" -an fast.mov`
- **Burn in captions** from an `.srt` file: `ffmpeg -i demo.mp4 -vf subtitles=captions.srt captioned.mp4`

### Before you send it

- No `.env`, password, API key or terminal settings visible anywhere.
- Only sample or consented data on screen.
- The numbers on screen come from the rehearsal; the money figure uses the staff cost you set (`STAFF_COST_PER_HOUR`).
- Say once that quotes stay drafts until a person sends them.
