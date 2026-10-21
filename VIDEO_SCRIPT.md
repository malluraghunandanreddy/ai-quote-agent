# Recording the end-to-end demo video (about 8 minutes)

**What the viewer sees:** a customer's email arrives from a real address with an Excel attached → the assistant reads it → finds the customer in Zoho Books → a **draft** quote appears → your team gets an alert email → the dashboard shows what happened → the awkward cases (an unknown item, an unknown customer, no attachment) are handled without guessing.

**Who records it:** you. I can't record a screen from here. QuickTime does it (Cmd+Shift+5). This Mac also has `ffmpeg`, so trimming, captions and compressing are one command each (end of this page). The kit below makes the recording a one-take job.

> **Not run on a real mailbox yet.** The mailbox and email-sending parts have never run against a live server. Do the setup and one full rehearsal (Part 1) before recording anything.

---

## Part 1: Set-up with one Gmail address (about 10 minutes)

This uses only `yourname@gmail.com`. It is for the demo only; a real client gets a dedicated quotes mailbox (see the end of this part).

**How it works in one line:** customers email `yourname+rfq@gmail.com`. Gmail delivers any `+word` address to your normal mailbox, so it arrives in your Inbox, and the assistant acts only on mail addressed to that `+rfq` address. All your other email is left alone: not opened, not marked read, not moved.

### Step 1: Get a Gmail app password (about 3 minutes)

Gmail will not let a program in with your normal password. Open **https://myaccount.google.com/apppasswords** while signed in as `yourname@gmail.com`. If Google says 2-Step Verification must be on, turn it on first (Google Account, Security, 2-Step Verification) and come back. Type the name `Quote assistant` and click Create. Google shows a 16-letter code. Keep that page open or copy the code. The next step asks for it.

### Step 2: Run one command

```bash
npm run setup:gmail -- yourname@gmail.com
```

It asks you two things, typed hidden:
1. The 16-letter app password (paste it; spaces are fine).
2. A password for the dashboard (at least 10 characters), twice.

Then it does everything else: it writes the mailbox settings into `.env` (your old file is saved as `.env.bak`), creates your dashboard login, tests the connection, and sends one test email to your Gmail. Look for ✓ on every line. If a line starts with ✗, it says in plain words what to fix.

### Step 3: Start the assistant

```bash
npm start
```

Leave that window open. It checks for new mail every minute and serves the dashboard at **http://localhost:3000** (stop `npm run demo` first if it is running). Sign in with `yourname@gmail.com` and the dashboard password you chose.

### Step 4: Make the demo emails (once, and again before every recording)

```bash
npm run demo:kit -- --check
```

You should see four PASS lines. It creates the folder `demo-emails/` with four ready-to-send emails and their Excel files.

### Step 5: Send one and watch

In Gmail choose Compose. **To:** `yourname+rfq@gmail.com`. Take the subject and body from `demo-emails/1-draft-ready/email.txt` and attach the Excel file from the same folder. Send. Within a minute: the dashboard shows the new enquiry, Zoho Books (Sales, Quotes) has a new draft, and your Gmail has an alert email (search for `Quote agent`).

If nothing happens after two minutes, open the email in Gmail and choose the three-dots menu, then "Mark as unread". The assistant only picks up unread mail, and Gmail sometimes shows a message you sent to yourself as already read. Mail that other people send you arrives unread as normal, so this only matters when you test from your own address.

Send all four once as a rehearsal. Rehearsal drafts stay in Zoho Books until you decide what to do with them; I only delete Zoho drafts if you tell me to.

### Later, for a real client

Nothing here carries over. The client gets a dedicated company quotes mailbox, a sending account for alerts, and their sales team's own addresses. After the demo, **delete the Gmail app password** (Google Account, Security, App passwords): it gives full access to the mailbox.

---

## Part 2: Screen set-up

- One browser window, full screen, **zoom 110 to 125%**, bookmarks bar hidden, notifications and Do Not Disturb on.
- Four tabs, in this order: **(1)** Gmail, ready to compose the customer's email, **(2)** the dashboard, **(3)** Zoho Books → Sales → Quotes, **(4)** a second Gmail tab searching for `Quote agent` (the team's alerts). Tabs 1 and 4 are the same Gmail account, so keep your Inbox out of sight.
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
