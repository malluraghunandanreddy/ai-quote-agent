#!/bin/sh
set -e
# First start: seed the standalone folder with the starter price list.
mkdir -p "$STANDALONE_DIR"
[ -e "$STANDALONE_DIR/price_list.xlsx" ] || [ -e "$STANDALONE_DIR/price_list.xls" ] || [ -e "$STANDALONE_DIR/price_list.csv" ] \
  || cp /app/data/standalone/price_list.xlsx "$STANDALONE_DIR/price_list.xlsx"
exec "$@"
