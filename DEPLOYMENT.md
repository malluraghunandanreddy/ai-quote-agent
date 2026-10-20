# Deploying the AI Quote Agent for a client

One installation per client (single-tenant). Two ways to run it:

| | **A. We host it** (recommended) | **B. On the client's server** |
|---|---|---|
| Who runs the server | Us, on a cloud server for this client only | The client's IT (or us, by remote session) |
| Address | `https://quotes.<client-domain>` (HTTPS) | Internal, e.g. `http://quote-agent.local:8000`, or behind their VPN / reverse proxy |
| Commercials | Setup fee + monthly service (hosting, monitoring, updates, support) | Setup fee + annual maintenance |
| Usage costs | Client's own Gemini billing account (pass-through); Zoho API is included in their Zoho plan | Same |

## 0. One-time, before the first client deployment
- [ ] Keep the code in a **private Git repository**. Deploying and updating means `git clone` / `git pull`.
- [ ] **Test the Docker build on a Linux server.** The Docker files exist but haven't been built yet, because
      Docker wasn't available on the development machine.
- [ ] Recommended before a paid go-live: a client login without Setup access, encrypted credentials,
      automatic deletion of old email content (DPDP Act), and the Gemini **paid** tier.

## Server requirements
- Ubuntu 24.04 LTS (any Linux with Docker works); **2 vCPU, 4 GB RAM, 30 GB disk**.
- **Outgoing** access only:

| Host | Port | Used for |
|---|---|---|
| `accounts.zoho.in`, `www.zohoapis.in` | 443 | Zoho Books login and API (`.com` / `.eu` etc. for other data centres) |
| `imappro.zoho.in` / `smtppro.zoho.in` | 993 / 465 | Reading the inbox, sending notifications |
| `generativelanguage.googleapis.com` | 443 | Gemini |

- No incoming internet connection is needed for the agent itself: it fetches mail by polling. Only people
  opening the dashboard need to reach the server (port 443 for A; port 8000 or their proxy for B).
- The dashboard's styling loads from `cdn.tailwindcss.com` in the **user's browser**. Staff browsers need
  internet access, or ask us to bundle it.

## A. Hosted by us

1. **Create the server** in an India region: AWS Mumbai, Azure Central India, Google Cloud Mumbai, or
   DigitalOcean Bangalore. Firewall: 22 (your IP only), 80, 443.
2. **DNS:** ask the client to add an A record, `quotes.<client-domain>` → the server's IP.
3. **Install Docker** (official script): `curl -fsSL https://get.docker.com | sh`
4. **Get the code and settings:**
   ```bash
   git clone <private-repo-url> quote-agent && cd quote-agent
   cp .env.example .env && chmod 600 .env
   ```
   In `.env` set:
   - `DOMAIN=quotes.<client-domain>` and `BIND_ADDRESS=127.0.0.1`
   - `DASHBOARD_URL=https://quotes.<client-domain>` (used for links in emails)
   - `LOCK_ERP_CONNECTOR=zoho_books` and `LOCK_AI_PROVIDER=gemini`
   - `ADMIN_PASSWORD` (a strong password, kept by us)
   - `MONITORED_INBOX`, `SALES_TEAM_EMAIL`, `ALERT_RECIPIENTS`
5. **Start it:**
   ```bash
   docker compose --profile https up -d --build
   ```
   The HTTPS certificate is issued automatically on first start; the DNS record must already point at the server.
6. **Configure:** open `https://quotes.<client-domain>`, log in, then go to **Setup**:
   - Gemini key (from the client's own Google account and billing)
   - **Connect Zoho Books**
   - the mailbox app password
   Then press **Test connections** and check every line is ✅.
7. **Backups:** schedule them daily, keep 14, and copy them off the server.
   ```bash
   crontab -e
   0 2 * * * cd ~/quote-agent && docker compose exec -T quote-agent python scripts/backup.py --keep 14
   ```
   Copy them out with `docker compose cp quote-agent:/data/backups ./backups`, then to S3 / Drive.
8. **Monitoring:** check `docker compose ps` and `docker compose logs -f quote-agent`, and add an uptime check
   on `https://quotes.<client-domain>/login`.

## B. On the client's server
- Same steps 3–6, run by their IT with this guide or by us over a remote session.
- Internal-only access: keep `BIND_ADDRESS=0.0.0.0`, skip the `https` profile (`docker compose up -d --build`),
  and open `http://<server>:8000` from their network. Alternatively, put it behind their existing reverse
  proxy or VPN.
- We enter the credentials on the Setup page during a screen-share. Their admin can then change
  `ADMIN_PASSWORD` if they own the installation.
- Backups (step 7) go to their storage.

## Updating
```bash
docker compose exec -T quote-agent python scripts/backup.py     # always back up first
git pull
docker compose up -d --build              # add --profile https for option A
```
Database changes are applied automatically on start.

## Restoring
```bash
docker compose stop quote-agent
docker compose run --rm quote-agent python scripts/backup.py --restore /data/backups/<file>.tar.gz
docker compose start quote-agent
```

## Where the data lives

| What | Where |
|---|---|
| Settings and credentials | `.env` next to `docker-compose.yml` (mode 600, never shown in the browser) |
| Enquiries, extracted lines, audit log, notification copies | SQLite database in the `quote-data` volume (`/data/poc_agent.db`) |
| Backups | `/data/backups` in the same volume, plus your off-server copy |
| Customers, products, prices, draft quotations | The client's own Zoho Books |

Data that leaves the server goes only to Zoho Books and Zoho Mail (the client's own accounts) and to Google
Gemini (email and attachment content, when AI is needed). Use Gemini's paid tier so Google doesn't use
the content for training.

## Go-live checklist
- [ ] HTTPS works (A) or internal URL reachable (B); admin password set
- [ ] Zoho Books connected; real items checked (codes, prices, GST)
- [ ] Mailbox connected; a real test email processed end to end
- [ ] Sales and stakeholder addresses correct; rules set (unmatched products, mandatory fields)
- [ ] Backups scheduled **and one restore tested**
- [ ] Gemini on a paid billing account owned by the client, with a budget alert
- [ ] Contract covers hosting or maintenance, data processing (Gemini), and our right to reuse the product
