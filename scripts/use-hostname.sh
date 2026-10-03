#!/usr/bin/env bash
#
# Point Crucible at a hostname: the two config URLs the QR codes and the emails read, and the
# web server's allowed-host list.
#
# Run this AFTER `scripts/named-tunnel.sh <hostname>` is serving. Both are idempotent, so
# re-running either is safe.
#
# Why the allowed-host list exists: Vite refuses a request whose `Host` header it does not
# recognise, and it is right to. A page on another site can make a browser on this network ask
# 127.0.0.1:5180 for the app, and without the check it would get it.
#
# Usage:  scripts/use-hostname.sh crucible.example.com
set -euo pipefail

HOSTNAME="${1:-}"
API="http://127.0.0.1:3101"
WEB_PORT="${VITE_WEB_PORT:-5180}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CREDS="$ROOT/EVENT-CREDENTIALS.local.txt"

[[ -n "$HOSTNAME" ]] || { echo "usage: $0 <hostname>" >&2; exit 2; }
[[ -f "$CREDS" ]] || { echo "no $CREDS — cannot sign in to set the URLs" >&2; exit 1; }

# The password is read into a variable and never echoed (P8.3).
PASSWORD="$(awk '/^admin@crucible.local/{print $2}' "$CREDS")"
[[ -n "$PASSWORD" ]] || { echo "no admin line in $CREDS" >&2; exit 1; }

TOKEN="$(curl -fsS -X POST "$API/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"admin@crucible.local\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["token"])')"

for pair in "event.register_url:https://$HOSTNAME/register" "event.submit_url:https://$HOSTNAME/submit"; do
  key="${pair%%:*}"; value="${pair#*:}"
  curl -fsS -X PATCH "$API/api/v1/platform/config/$key" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"value\":\"$value\"}" >/dev/null
  echo "  set $key = $value"
done

# Rebuild and restart the web server so the bundle is current and the hostname is accepted.
echo "==> Rebuilding the web bundle"
(cd "$ROOT" && pnpm --filter @crucible/web build >/dev/null)

echo "==> Restarting the web server on :$WEB_PORT"
# By port, not by process name: `vite preview` does not match a pattern containing 'web', and a
# missed kill leaves the stale process holding the port while the new one dies silently.
for pid in $(lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN -t 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
sleep 2

cd "$ROOT"
# The hostname AND its subdomains: a leading dot is a suffix match, so `www.` and anything else
# routed to the same tunnel is accepted without a second edit.
APEX="${HOSTNAME#www.}"
VITE_WEB_HOST=0.0.0.0 VITE_WEB_ALLOWED_HOSTS="$APEX,.$APEX" \
  nohup pnpm --filter @crucible/web exec vite preview > /tmp/crucible-web.log 2>&1 &

for _ in $(seq 1 30); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")" == "200" ]] && break
  sleep 1
done

echo
printf '%-24s %s\n' \
  "local"    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")" \
  "register" "$(curl -s -o /dev/null -w '%{http_code}' "https://$HOSTNAME/register")" \
  "submit"   "$(curl -s -o /dev/null -w '%{http_code}' "https://$HOSTNAME/submit")"
echo
echo "Done. The Intake page's QR codes now point at https://$HOSTNAME"
