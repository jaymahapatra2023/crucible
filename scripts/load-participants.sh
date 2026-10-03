#!/usr/bin/env bash
#
# Load (or RELOAD) the participant roster from the registration form export.
#
# Built to be run more than once. The list changes until the doors open: people register late,
# withdraw, or correct a typo in their own address. So this is idempotent on the email address,
# and it is careful about the one thing a reload can break — somebody already on a team.
#
# What it does:
#   1. parses the export into a CSV (by header name, not column position)
#   2. dry-runs the import and shows what would change
#   3. imports for real
#   4. reports people in the database who are NOT in the file, and removes only those who are
#      not on a team; anyone on a team is listed for a human to decide about
#
# Usage:  scripts/load-participants.sh "docs/codeLinc 11 - Registration Form to load - Google Sheets.html"
set -euo pipefail

SRC="${1:-}"
API="${API:-http://127.0.0.1:3101}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CREDS="$ROOT/EVENT-CREDENTIALS.local.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -n "$SRC" ]] || { echo "usage: $0 <registration-export.html|participants.csv>" >&2; exit 2; }
[[ -f "$SRC" ]] || { echo "no such file: $SRC" >&2; exit 2; }
[[ -f "$CREDS" ]] || { echo "no $CREDS — cannot sign in" >&2; exit 1; }

CSV="$WORK/participants.csv"
if [[ "$SRC" == *.csv ]]; then cp "$SRC" "$CSV"; else
  python3 "$ROOT/scripts/participants-from-sheet.py" "$SRC" "$CSV"
fi

PASSWORD="$(awk '/^admin@crucible.local/{print $2}' "$CREDS")"
TOKEN="$(curl -fsS -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@crucible.local\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["token"])')"

post() {  # $1 = confirm true|false
  python3 -c "
import json,sys
print(json.dumps({'kind':'participant','csv':open(sys.argv[1]).read(),'confirm':sys.argv[2]=='true'}))
" "$CSV" "$1" > "$WORK/req.json"
  curl -fsS -X POST "$API/api/v1/roster/import" -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' --data-binary @"$WORK/req.json"
}

echo "==> Dry run"
post false | python3 -c '
import sys, json
p = json.load(sys.stdin)["data"]
print("   ", p["summary"])
bad = [r for r in p["rows"] if r["outcome"] not in ("NEW", "EXISTING")]
for r in bad[:10]:
    print("    line", r["line"], r["outcome"], r.get("detail"))
if bad:
    raise SystemExit("refusing to import: fix the rows above first")
'

echo "==> Importing"
post true | python3 -c 'import sys, json; print("   ", json.load(sys.stdin)["data"]["summary"])'

echo "==> People in the database who are NOT in this file"
python3 - "$CSV" <<'PY'
import csv, subprocess, sys, os, re

csv_path = sys.argv[1]
wanted = {r['email'].strip().lower() for r in csv.DictReader(open(csv_path))}

env = open(os.path.join(os.path.dirname(csv_path), '..', '..')) if False else None
dsn = next((l.split('=', 1)[1].strip() for l in open('.env') if l.startswith('DATABASE_URL=')), '')

def q(sql):
    out = subprocess.run(['psql', dsn, '-X', '-q', '-t', '-A', '-F', '|', '-c', sql],
                         capture_output=True, text=True, check=True).stdout
    return [l.split('|') for l in out.splitlines() if l.strip()]

rows = q("""SELECT p.participant_id, p.full_name, p.email,
                   (SELECT count(*) FROM team_member m WHERE m.participant_id = p.participant_id)
              FROM participant p WHERE p.deleted_at IS NULL ORDER BY p.participant_id""")

stale = [r for r in rows if r[2].strip().lower() not in wanted]
if not stale:
    print("    none — the database matches the file")
else:
    on_team  = [r for r in stale if int(r[3]) > 0]
    free     = [r for r in stale if int(r[3]) == 0]
    for pid, name, email, _ in free:
        q(f"DELETE FROM registration_link WHERE participant_id = {pid}")
        q(f"DELETE FROM participant WHERE participant_id = {pid}")
        print(f"    removed {name} <{email}> (was not on a team)")
    for pid, name, email, n in on_team:
        print(f"    KEPT {name} <{email}> — already on a team ({n} membership). Remove by hand if that is wrong.")
PY

echo "==> Now on the roster"
python3 -c "
import subprocess
dsn = next(l.split('=',1)[1].strip() for l in open('.env') if l.startswith('DATABASE_URL='))
out = subprocess.run(['psql', dsn, '-X', '-q', '-c',
  'SELECT count(*) AS participants, count(DISTINCT organisation) AS institutions FROM participant WHERE deleted_at IS NULL'],
  capture_output=True, text=True).stdout
print(out.strip())
"
