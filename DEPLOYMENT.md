# Installing the quote assistant for a client

**One installation per client.** The client installs nothing: they get a web address and an owner login. You (the operator) put the assistant on a small Linux server, give it the client's own accounts, and hand the address over. The commands for each step are in [`deploy/README.md`](deploy/README.md); this page is the order of work and the checklist.

> This page replaces an older guide that described the first Python prototype (Gemini, a Setup page). That prototype is not what is deployed.

## Where it runs

| | **A. We host it** (recommended) | **B. On the client's server** |
|---|---|---|
| Who runs the server | You, on a small cloud server in an India region (one client per server, or several behind one shared HTTPS proxy) | The client's IT, or you by remote session |
| Address | `https://quotes.<client-domain>` | Their internal address, or behind their own proxy or VPN |
| Keys and passwords | You hold them | The client enters their own, so you never hold them |
| Fits | Most clients: nothing for them to look after | A client whose rules require it on their own server |

Server: Linux with Docker Engine and Docker Compose v2, about 1 GB of memory per client (a 1 vCPU, 2 GB server is plenty for one), ports 80 and 443 open (22 for you). Everything else is outgoing only: Zoho Books, the client's mailbox, and Anthropic's API.

## What you need from the client

- [ ] **A web address:** they add one DNS record, `quotes.<their-domain>` pointing at the server, before the first start (the HTTPS certificate is issued from it).
- [ ] **Their Zoho Books connection:** the API client id, secret and refresh token, created in their own Zoho organisation by a Zoho Books admin (see `LIVE_DEMO_SETUP.md`, the Zoho Books API step), plus the organisation id and data centre (`in`, `com`, ...).
- [ ] **The mailbox the requests arrive in:** its IMAP login, and a sender login for alert emails (SMTP). Gmail and Zoho Mail need an app password. Microsoft 365 is not supported yet.
- [ ] **Their AI key** (an Anthropic API key from their own account), or you decide to carry it. It is a small cost: a typical quote is about ₹0.02 of AI.
- [ ] **The owner's email address,** and the starting addresses for the Sales and stakeholder alerts (the owner can change them later in the dashboard, under Alerts).
- [ ] **Their items and prices** in Zoho Books (the onboarding form can load them), and their customer-specific pricing rules.

## Order of work

1. **Once, for your server:** build the image on your computer, copy it and the `deploy` folder to the server, load it, and start the shared HTTPS proxy (`deploy/README.md`, "One-time setup of the server").
2. **Per client:** run `deploy/new-client.sh <name> --mode proxy --domain quotes.<client-domain> --owner-email <owner> --client-name "<Client>"`. It makes the client's folder, a private settings file and a helper, and prints the owner's starting password once.
3. **Fill the client's settings file** (`.env` in their folder): their Zoho Books connection, mailbox, alert addresses, AI key, branding, time zone, and `STAFF_COST_PER_HOUR` so the dashboard can show money saved.
4. **Check, then start:** `./ctl.sh check` (lists anything missing and starts nothing), `./ctl.sh up`, `./ctl.sh status` until it says healthy, then `./ctl.sh preflight` to prove the real connections work (mailbox, alert emails, Zoho Books, Claude). It changes nothing.
5. **Hand over the owner login:** the owner signs in with the starting password and chooses their own. Then delete the `DASHBOARD_PASSWORD` line from `.env` and run `./ctl.sh up` again.
6. **Load their items** (and customers, if you want them there before the first email) with the onboarding form, then restart so the item list is fresh.
7. **Rehearse on their real mailbox and their real Zoho Books:** send an email, watch the draft appear, check the alerts reach the right people, send the draft from Zoho Books to yourself. Do the same once with a brand-new customer (the one-click form).
8. **Backups:** the service backs up nightly and keeps 14. Also copy the backup folder off the server on a schedule, and try one restore before go-live.
9. **Pilot:** go live with every draft reviewed by their team, and agree what "working" means (share of quotes made without typing, time saved, lines needing manual pricing).

## Go-live checklist

- [ ] HTTPS address opens and the owner has their own password
- [ ] Zoho Books connected; real items checked (codes, prices, GST), place of supply set on customers if the organisation uses GST
- [ ] Mailbox connected; one real email processed end to end, including a new customer and a line that cannot be matched
- [ ] Alert addresses correct for Sales and stakeholders (test emails sent from the Alerts page)
- [ ] Logins created and roles checked (owner, manager, staff, viewer)
- [ ] Backups running, copied off the server, and one restore tested
- [ ] The AI key is on an account with a budget alert
- [ ] The contract covers hosting or maintenance, the fact that email text is read by an AI service, and your right to reuse the product

## Not yet proven

- The Docker image and compose files have **never been built or run** on a Linux server (Docker was not available on the development computer). **Do a full trial install on a throwaway server before the first client.**
- HTTPS through the proxy, the shared proxy with several clients, and the update and restore commands are untested for the same reason.
- Nothing has been tried against a client's own Zoho Books organisation or their own mailbox: only the operator's demo accounts.
- There is no automatic off-server backup, and no single screen across several clients.

## Updating and support

`deploy/README.md` has the update, rollback and restore commands. The database upgrades itself when a new version starts. Update one client first and watch `./ctl.sh logs`.
