#!/usr/bin/env bash
#
# Keep the roster in step with the registration sheet while people are arriving.
#
# Pulls the rows marked as registered, imports the new ones, and leaves everyone else alone. Run
# it once, or with --watch to repeat every few minutes through the morning.
#
# It is safe to run repeatedly. The importer matches on email address, so an arrival already on
# the roster is reported as EXISTING and nothing is rewritten.
#
# It does NOT remove anybody. `load-participants.sh` is the one that reconciles both ways, which
# is right for a final load and wrong here: somebody who registered, got onto a team and then was
# edited out of the sheet must not be deleted out from under their team at 2pm.
#
# Usage:
#   scripts/sync-participants.sh <csv-url> [--gate C] [--watch 180]
set -euo pipefail

URL="${1:-}"
API="${API:-http://127.0.0.1:3101}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CREDS="$ROOT/EVENT-CREDENTIALS.local.txt"
GATE="C"
EVERY=""

[[ -n "$URL" ]] || { echo "usage: $0 <csv-url> [--gate C] [--watch 180]" >&2; exit 2; }
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate)  GATE="$2"; shift 2 ;;
    --watch) EVERY="${2:-180}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -f "$CREDS" ]] || { echo "no $CREDS — cannot sign in" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

one_pass() {
  local csv="$WORK/participants.csv"
  python3 "$ROOT/scripts/participants-from-csv-url.py" "$URL" "$csv" --gate "$GATE"

  # Never create a SECOND row for somebody already on the roster. Google's published CSV is
  # eventually consistent — two fetches seconds apart return different copies — so a row deleted
  # from the sheet can arrive again from a stale cache and fork one person into two participants
  # who could then land on two different teams.
  local dsn roster filtered
  dsn="$(sed -n 's/^DATABASE_URL=//p' "$ROOT/.env" | head -1)"
  roster="$WORK/roster.txt"
  filtered="$WORK/filtered.csv"
  psql "$dsn" -X -q -t -A -F'|' \
    -c "SELECT full_name, email FROM participant WHERE deleted_at IS NULL" > "$roster"
  python3 "$ROOT/scripts/_drop_known_names.py" "$csv" "$filtered" "$roster" \
    "$ROOT/scripts/sync-exclude.txt"
  csv="$filtered"

  local password token
  password="$(awk '/^admin@crucible.local/{print $2}' "$CREDS")"
  token="$(curl -fsS -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"admin@crucible.local\",\"password\":\"$password\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["token"])')"

  python3 -c "
import json, sys
print(json.dumps({'kind':'participant','csv':open(sys.argv[1]).read(),'confirm':True}))
" "$csv" > "$WORK/req.json"

  curl -fsS -X POST "$API/api/v1/roster/import" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' --data-binary @"$WORK/req.json" \
    | python3 -c '
import sys, json
d = json.load(sys.stdin)["data"]
s = d["summary"]
print("  added", s["new"], "| already on the roster", s["existing"], "| unusable", s["invalid"])
# Printed loudly. The importer refuses a whole file if any row is unusable, and a refusal that
# scrolled past unnoticed meant the sync reported arrivals it had not actually written.
if d.get("refusal"):
    print("  NOTHING WAS WRITTEN:", d["refusal"])
    raise SystemExit(1)
'
}

if [[ -z "$EVERY" ]]; then
  one_pass
else
  echo "Syncing every ${EVERY}s. Ctrl-C to stop."
  while true; do
    printf '[%s] ' "$(date '+%H:%M:%S')"
    one_pass || echo "  pass failed; will try again"
    sleep "$EVERY"
  done
fi
