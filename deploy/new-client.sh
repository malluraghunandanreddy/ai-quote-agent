#!/usr/bin/env bash
# Set up the folder for a new client. Creates the settings file, folders and helper commands; starts nothing.
#
#   deploy/new-client.sh acme --mode proxy --domain quotes.acme.com --owner-email md@acme.com --client-name "Acme Industries"
#
# Modes:
#   local   no HTTPS here; reachable on this machine only (testing, or the client's own reverse proxy in front)
#   https   one client on this server: a built-in proxy gets the HTTPS certificate (needs --domain)
#   proxy   several clients on this server share one proxy from deploy/proxy (needs --domain)
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${QUOTE_CLIENTS_DIR:-/srv/quote-clients}"
PROXY_DIR="${QUOTE_PROXY_DIR:-/srv/quote-proxy}"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  cat >&2 <<'OPTS'

Options:
  --mode local|https|proxy     (default: local)
  --domain quotes.acme.com     public address (required for https and proxy)
  --owner-email md@acme.com    who signs in first as Owner (required)
  --client-name "Acme"         shown in the dashboard
  --port 3001                  loopback port on this machine (default: next free from 3001)
  --version 1.0.0              image version to run (default: latest)
  --dir /srv/quote-clients     where client folders live (or set QUOTE_CLIENTS_DIR)
OPTS
  exit 2
}

[ $# -ge 1 ] || usage
NAME="$1"
shift
MODE="local"
DOMAIN=""
OWNER=""
CLIENT_NAME=""
PORT=""
VERSION="latest"

while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case "$1" in
    --mode) MODE="$2" ;;
    --domain) DOMAIN="$2" ;;
    --owner-email) OWNER="$2" ;;
    --client-name) CLIENT_NAME="$2" ;;
    --port) PORT="$2" ;;
    --version) VERSION="$2" ;;
    --dir) BASE="$2" ;;
    *) usage ;;
  esac
  shift 2
done

fail() { echo "Error: $1" >&2; exit 1; }

case "$NAME" in
  [a-z0-9]*) ;;
  *) fail "the client name must start with a lowercase letter or digit" ;;
esac
case "$NAME" in
  *[!a-z0-9-]*) fail "the client name may only contain lowercase letters, digits and hyphens" ;;
esac
[ "${#NAME}" -le 30 ] || fail "the client name must be 30 characters or fewer"
case "$MODE" in local | https | proxy) ;; *) fail "--mode must be local, https or proxy" ;; esac
if [ "$MODE" != "local" ] && [ -z "$DOMAIN" ]; then fail "--domain is required for --mode $MODE"; fi
if [ -n "$DOMAIN" ]; then
  case "$DOMAIN" in
    *[!A-Za-z0-9.-]* | .* | *. | -*) fail "that domain does not look right: $DOMAIN" ;;
    *.*) ;;
    *) fail "that domain does not look right: $DOMAIN" ;;
  esac
fi
case "$OWNER" in
  ?*@?*.?*) ;;
  *) fail "--owner-email is required and must be an email address" ;;
esac
case "$VERSION" in "" | *[!A-Za-z0-9._-]*) fail "--version may only contain letters, digits, dots, hyphens and underscores" ;; esac
[ -n "$CLIENT_NAME" ] || CLIENT_NAME="$NAME"
case "$CLIENT_NAME" in
  *'$'* | *"'"* | *'#'* | *'`'* | *'"'*) fail "--client-name cannot contain \$ ' \" # or backticks (the settings file treats them specially)" ;;
esac

DIR="$BASE/$NAME"
[ ! -e "$DIR" ] || fail "$DIR already exists. Nothing was changed."

# Next free loopback port: one above the highest already used by a client on this machine.
if [ -z "$PORT" ]; then
  PORT=3001
  for f in "$BASE"/*/.env; do
    [ -f "$f" ] || continue
    used="$(sed -n 's/^HOST_PORT=//p' "$f" | head -n 1)"
    case "$used" in "" | *[!0-9]*) continue ;; esac
    [ "$used" -ge "$PORT" ] && PORT=$((used + 1))
  done
fi
case "$PORT" in "" | *[!0-9]*) fail "--port must be a number" ;; esac

PROJECT="qa-$NAME"
case "$MODE" in
  local) COMPOSE_FILE="docker-compose.yml"; PROFILES=""; PUBLIC_URL="http://127.0.0.1:$PORT" ;;
  https) COMPOSE_FILE="docker-compose.yml"; PROFILES="https"; PUBLIC_URL="https://$DOMAIN" ;;
  proxy) COMPOSE_FILE="docker-compose.yml:docker-compose.proxy.yml"; PROFILES=""; PUBLIC_URL="https://$DOMAIN" ;;
esac

# A starting password for the first Owner (14 characters, no look-alikes). They must replace it at first sign-in.
PASSWORD="$(LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 14)"
[ "${#PASSWORD}" -eq 14 ] || fail "could not generate a starting password"

sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }

mkdir -p "$DIR/data" "$DIR/branding"
cp "$HERE/docker-compose.yml" "$DIR/docker-compose.yml"
[ "$MODE" = "proxy" ] && cp "$HERE/docker-compose.proxy.yml" "$DIR/docker-compose.proxy.yml"
cp "$HERE/ctl.sh" "$DIR/ctl.sh"
chmod 755 "$DIR/ctl.sh"

(
  umask 077
  sed \
    -e "s|__PROJECT__|$(sed_escape "$PROJECT")|g" \
    -e "s|__COMPOSE_FILE__|$(sed_escape "$COMPOSE_FILE")|g" \
    -e "s|__PROFILES__|$(sed_escape "$PROFILES")|g" \
    -e "s|__VERSION__|$(sed_escape "$VERSION")|g" \
    -e "s|__PORT__|$(sed_escape "$PORT")|g" \
    -e "s|__DOMAIN__|$(sed_escape "$DOMAIN")|g" \
    -e "s|__CLIENT_NAME__|$(sed_escape "$CLIENT_NAME")|g" \
    -e "s|__PUBLIC_URL__|$(sed_escape "$PUBLIC_URL")|g" \
    -e "s|__OWNER_EMAIL__|$(sed_escape "$OWNER")|g" \
    -e "s|__OWNER_PASSWORD__|$(sed_escape "$PASSWORD")|g" \
    "$HERE/client.env.example" >"$DIR/.env"
)
chmod 600 "$DIR/.env"

# The container runs as uid 1000 and must be able to write the data folder.
if [ "$(id -u)" -eq 0 ]; then
  chown -R 1000:1000 "$DIR/data" "$DIR/branding"
elif [ "$(id -u)" -ne 1000 ]; then
  echo "Note: run  sudo chown -R 1000:1000 $DIR/data $DIR/branding  so the service can write its data." >&2
fi

SITE_NOTE=""
if [ "$MODE" = "proxy" ]; then
  SITE="$(printf '%s {\n\tencode zstd gzip\n\treverse_proxy %s-app:3000\n}\n' "$DOMAIN" "$PROJECT")"
  if [ -d "$PROXY_DIR/sites" ]; then
    printf '%s\n' "$SITE" >"$PROXY_DIR/sites/$NAME.caddy"
    SITE_NOTE="Added $PROXY_DIR/sites/$NAME.caddy. Tell the proxy:  docker compose -f $PROXY_DIR/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile"
  else
    SITE_NOTE="The shared proxy folder $PROXY_DIR was not found. Set it up once (see deploy/README.md), then save this as $PROXY_DIR/sites/$NAME.caddy:
$SITE"
  fi
fi

cat <<DONE

Created $DIR  (mode: $MODE, port $PORT on this machine)

First owner:   $OWNER
Starting password (shown only now; it is also in .env until you remove it after their first sign-in):
    $PASSWORD

Next:
  1. Fill in the Zoho, mailbox, alert-email and Claude settings:   nano $DIR/.env
  2. Optional: put the logo in $DIR/branding and set BRAND_LOGO=branding/<file> in .env
  3. cd $DIR && ./ctl.sh check      (lists anything still missing)
  4. ./ctl.sh up                    (starts it)
  5. ./ctl.sh status                (healthy after a minute or two)
DONE
if [ -n "$SITE_NOTE" ]; then
  printf '\n%s\n' "$SITE_NOTE"
fi
if [ "$MODE" != "local" ]; then
  printf '\nMake sure %s points at this server in DNS before the first start, so the certificate can be issued.\n' "$DOMAIN"
fi
