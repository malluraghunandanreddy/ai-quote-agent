# Running the quote agent in Docker (one folder per client)

**Status:** the pieces below were checked outside Docker (the build steps, a production-only install, running read-only from a clean environment, the health-check command, the first-owner login, the backup and user commands, the new-client script). The image itself, the compose files and the HTTPS certificate step have **not been run yet** because Docker is not installed on the machine this was written on. Do the first run on a spare server, with a throwaway client, before trusting it with a real one.

## What you get

| Piece | What it is |
|---|---|
| `deploy/Dockerfile` | One image for every client: compiled code only, no secrets, runs as a normal user, checks its own health |
| `deploy/new-client.sh` | Creates a client's folder: compose file, a private `.env`, data and branding folders, a helper `ctl.sh` |
| `deploy/ctl.sh` | The client's day-to-day commands (start, logs, backups, add a login, update) |
| `deploy/proxy/` | One shared HTTPS front door when several clients live on the same server |
| `deploy/build.sh` | Builds the image, and can save it to a file to copy to a server |

Each client has their own folder, database, settings and (optionally) address. Nothing is shared between clients except the image and the proxy.

## Before you start

- A Linux server with **Docker Engine and Docker Compose v2** (`docker compose version` works). 1 GB of memory per client is comfortable.
- Ports **80 and 443** open to the internet (and 22 for you). Nothing else.
- For each client, a DNS name such as `quotes.acme.com` pointing at the server (needed before the first start so the certificate can be issued).
- The client's own credentials, created by the client in their own accounts: the Zoho Books API client and refresh token (see `NODE_AGENT.md` and `DEPLOYMENT.md`), the mailbox RFQs arrive in (IMAP), an SMTP login for alert emails, and an Anthropic API key. You never need to see them if the client types them in `.env` themselves.

## One-time setup of the server

1. **Build the image** on your computer (an Apple-silicon Mac needs the platform flag for a normal Linux server):
   ```bash
   deploy/build.sh --platform linux/amd64 --save
   ```
2. **Copy it and the deploy folder to the server**, then load it:
   ```bash
   scp dist-image/quote-agent-1.0.0.tar.gz you@server:
   scp -r deploy you@server:
   ssh you@server 'gunzip -c quote-agent-1.0.0.tar.gz | docker load'
   ```
3. **Start the shared proxy** (skip this if the server will only ever hold one client; use `--mode https` below instead):
   ```bash
   sudo mkdir -p /srv/quote-clients && sudo cp -r deploy/proxy /srv/quote-proxy
   cd /srv/quote-proxy && sudo docker compose up -d
   ```

## Add a client

```bash
sudo deploy/new-client.sh acme --mode proxy --domain quotes.acme.com \
     --owner-email md@acme.com --client-name "Acme Industries"
```

It prints the owner's starting password once. Then:

```bash
cd /srv/quote-clients/acme
sudo nano .env            # Zoho, mailbox, alert emails, Claude key, branding
sudo ./ctl.sh check       # lists anything still missing; starts nothing
sudo ./ctl.sh up
sudo ./ctl.sh status      # "healthy" after a minute or two
```

Open the client's address, sign in as the owner with the starting password, and choose a new password. Then delete the `DASHBOARD_PASSWORD` line from `.env` (and run `./ctl.sh up` once more). Hand the address to the owner; they add their own team from the Team page.

If the server is not on the internet yet or you want to look first, `--mode local` skips HTTPS and answers only on the machine itself (`http://127.0.0.1:<port>`; an SSH tunnel such as `ssh -L 3001:127.0.0.1:3001 you@server` lets you open it from your computer).

| Mode | Use it when | HTTPS comes from |
|---|---|---|
| `proxy` | Several clients on one server (your hosting) | The shared proxy in `/srv/quote-proxy` |
| `https` | One client on the server (often the client's own) | A small proxy started with that client |
| `local` | Testing, or the client puts their own reverse proxy in front | Nothing here |

## Everyday commands (from the client's folder)

| Command | What it does |
|---|---|
| `./ctl.sh check` | Are all needed settings filled in? |
| `./ctl.sh up` / `down` / `restart` | Start (or apply `.env` changes) / stop / restart |
| `./ctl.sh status` / `logs [lines]` | Healthy? / what is it doing |
| `./ctl.sh users` ... | List people, `add a@b.com "Name" owner`, `reset a@b.com` (a forgotten owner password) |
| `./ctl.sh once` | Check the mailbox right now (real emails are processed) |
| `./ctl.sh backup` / `backups` / `restore <file>` | Back up now / list / put one back (asks first) |
| `./ctl.sh update <version>` | Back up, then switch to another loaded image version |

## Updating, and going back

```bash
# on your computer
deploy/build.sh --platform linux/amd64 --save          # version comes from package.json
# on the server
gunzip -c quote-agent-1.1.0.tar.gz | docker load
cd /srv/quote-clients/acme && ./ctl.sh update 1.1.0     # backs up first, then restarts on the new version
./ctl.sh update 1.0.0                                    # back to the previous one if needed
```

The database upgrades itself when a new version starts. Update one client first, watch `./ctl.sh logs`, then the others.

## Backups and restore

The service backs up every night to `<client folder>/data/backups` (the newest 14 are kept) and the Status page shows the last one. That folder is on the same disk as the data, so also **copy it off the server**, for example a nightly job on another machine:

```bash
rsync -a you@server:/srv/quote-clients/ /backups/quote-clients/
```

To restore: `./ctl.sh backups`, then `./ctl.sh restore quote-agent-20261020-020000.sqlite`.

## Security notes

- `.env` holds the keys: it is created readable by its owner only. Do not email it or paste it in chat.
- A value containing `$` or `#` must be wrapped in single quotes in `.env` (`IMAP_PASSWORD='pa$$w#rd'`), or it is cut short.
- The app listens on the server's loopback only; the only way in from outside is the proxy on 80/443. The container runs as a normal user with a read-only filesystem, no extra privileges and a memory limit, and keeps no secrets in the image.
- To change a key (for example a rotated Anthropic key): edit `.env`, then `./ctl.sh up`.
- Keep the server's operating system and Docker updated.

## When the client hosts it themselves

Give them the image file, the `deploy` folder and this guide, and have them run the same steps with `--mode https` (or `local` behind their own proxy). They enter their own keys, so you never hold them. Anything you need to see, they send or share on a call; or their owner adds you a temporary Manager login and switches it off afterwards.

## Not in this package yet

Docker was not available to run the image or compose files; there is no automatic off-server backup; no single screen to see all clients at once; no licence check for a client-hosted copy (your protection there is the contract); alert emails still use the standard wording.
