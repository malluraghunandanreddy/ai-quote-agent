#!/usr/bin/env bash
# Everyday commands for this client's quote agent. Run it from this folder:  ./ctl.sh help
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env here. Run this from the client's folder (the one new-client.sh created)." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed on this machine." >&2
  exit 1
fi

# Read one value from .env (without sourcing it, because passwords may contain $ or #).
env_get() { sed -n "s/^$1=//p" .env | head -n 1 | sed -e "s/^'//" -e "s/'\$//"; }

dc() { docker compose "$@"; }
# One-off container with the same settings and data, whether or not the service is running.
run() { dc run --rm --no-deps "$@"; }

cmd="${1:-help}"
[ $# -gt 0 ] && shift

case "$cmd" in
  up)
    dc up -d
    echo
    echo "Started. Check it with:  ./ctl.sh status    Dashboard: $(env_get PUBLIC_DASHBOARD_URL)"
    ;;
  down)
    dc down
    ;;
  restart)
    dc restart app
    ;;
  status)
    dc ps
    echo
    echo "Dashboard: $(env_get PUBLIC_DASHBOARD_URL)"
    echo "Healthy means the mailbox was checked in the last few minutes. 'starting' is normal for the first 90 seconds."
    ;;
  logs)
    dc logs --tail "${1:-200}" -f app
    ;;
  check)
    # Is everything the service needs filled in? Prints plain-language problems and starts nothing.
    run -T app node -e '
      try {
        const c = require("./dist/config");
        const cfg = c.getConfig();
        c.requireZoho(cfg);
        c.requireImap(cfg);
        console.log("Settings look complete.");
        if (!cfg.smtp) console.log("Note: SMTP_HOST is not set, so alert emails are only written to the log.");
        if (!cfg.llm.enabled) console.log("Note: Claude is off (" + cfg.llm.disabledReason + "); only the rules-based reading runs.");
      } catch (e) { console.error(e.message); process.exit(1); }'
    ;;
  preflight)
    # Try the real mailbox, alert sending, Zoho Books and Claude, and say in plain words what is wrong. Changes nothing
    # (add --send to also send one test email to the internal address).
    run -T app node dist/ops/preflight.js "$@"
    ;;
  users)
    # ./ctl.sh users                      list people
    # ./ctl.sh users add a@b.com "Name" owner|manager|staff|viewer
    # ./ctl.sh users reset a@b.com        new one-time password
    run app node dist/ops/usersCli.js "$@"
    ;;
  backup)
    run app node dist/ops/cli.js backup
    ;;
  backups)
    run app node dist/ops/cli.js list
    ;;
  restore)
    file="${1:-}"
    if [ -z "$file" ]; then
      echo "Usage: ./ctl.sh restore <backup file name>   (see ./ctl.sh backups)" >&2
      exit 2
    fi
    case "$file" in */*) ;; *) file="/data/backups/$file" ;; esac
    echo "This replaces the current database with $file. The service is stopped while it happens."
    printf 'Type yes to continue: '
    read -r answer
    [ "$answer" = "yes" ] || { echo "Cancelled."; exit 1; }
    dc stop app
    run app node dist/ops/cli.js restore "$file" --yes
    dc up -d app
    ;;
  once)
    # Check the mailbox right now instead of waiting for the next scheduled check. Real emails are processed.
    run app node dist/index.js --once
    ;;
  update)
    version="${1:-}"
    case "$version" in
      "" | *[!A-Za-z0-9._-]*)
        echo "Usage: ./ctl.sh update <version>   (the image must already be loaded: docker images quote-agent)" >&2
        exit 2
        ;;
    esac
    if ! docker image inspect "quote-agent:$version" >/dev/null 2>&1; then
      echo "The image quote-agent:$version is not on this machine. Load it first (docker load)." >&2
      exit 1
    fi
    echo "Taking a backup first..."
    run app node dist/ops/cli.js backup || echo "(Backup skipped: the service has not been started yet.)"
    sed -e "s|^QUOTE_AGENT_VERSION=.*|QUOTE_AGENT_VERSION=$version|" .env >.env.tmp
    mv .env.tmp .env
    chmod 600 .env
    dc up -d
    echo "Now running version $version. To go back: ./ctl.sh update <the previous version>"
    ;;
  help | *)
    cat <<'HELP'
Commands (run from this client's folder):
  ./ctl.sh check            is every needed setting filled in? (starts nothing)
  ./ctl.sh up               start, or apply changes made in .env
  ./ctl.sh status           running and healthy?
  ./ctl.sh logs [lines]     follow what it is doing (Ctrl+C to stop looking)
  ./ctl.sh restart          restart the service
  ./ctl.sh down             stop and remove the container (data is kept)
  ./ctl.sh users ...        list people, add a login, reset a password
  ./ctl.sh once             check the mailbox right now
  ./ctl.sh backup           take a backup now
  ./ctl.sh backups          list backups
  ./ctl.sh restore <file>   put a backup back (asks first)
  ./ctl.sh update <ver>     back up, then switch to another loaded image version
HELP
    ;;
esac
