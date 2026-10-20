#!/usr/bin/env bash
# Build the quote-agent image from the project (run from anywhere).
#
#   deploy/build.sh                       build for this computer
#   deploy/build.sh --platform linux/amd64    build for a typical Linux server (needed on an Apple-silicon Mac)
#   deploy/build.sh --save                also write a file you can copy to a server:  dist-image/quote-agent-<version>.tar.gz
#
# On the server:  gunzip -c quote-agent-<version>.tar.gz | docker load
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PLATFORM=""
SAVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      [ $# -ge 2 ] || { echo "--platform needs a value, e.g. linux/amd64" >&2; exit 2; }
      PLATFORM="$2"
      shift 2
      ;;
    --save) SAVE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed on this machine." >&2; exit 1; }

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
[ -n "$VERSION" ] || { echo "Could not read the version from package.json" >&2; exit 1; }

echo "Building quote-agent:$VERSION ..."
if [ -n "$PLATFORM" ]; then
  docker build --platform "$PLATFORM" -f deploy/Dockerfile -t "quote-agent:$VERSION" -t quote-agent:latest .
else
  docker build -f deploy/Dockerfile -t "quote-agent:$VERSION" -t quote-agent:latest .
fi

if [ "$SAVE" -eq 1 ]; then
  mkdir -p dist-image
  OUT="dist-image/quote-agent-$VERSION.tar.gz"
  docker save "quote-agent:$VERSION" | gzip >"$OUT"
  echo "Wrote $OUT"
fi
echo "Done. Version: $VERSION"
