#!/usr/bin/env bash
#
# Put Crucible on a stable vanity hostname via a NAMED Cloudflare tunnel.
#
# Why not the quick tunnel: `cloudflared tunnel --url` gets a random hostname, loses it on every
# restart, and Cloudflare can revoke it mid-session (it did, on 2 October 2026, with the process
# still running and looking healthy). The in-app QR codes are rendered from the configured
# register and submit URLs, so a rotating hostname silently invalidates anything already printed.
# A named tunnel is bound to a hostname you own and survives restarts.
#
# Prerequisite you cannot skip: a domain in a Cloudflare account. `cloudflared tunnel login`
# asks which zone to authorise, and with no zone there is nothing to authorise. A domain is a
# few dollars at any registrar; Cloudflare's own registrar sells at cost.
#
# Usage:  scripts/named-tunnel.sh crucible.example.com [local-port]
set -euo pipefail

HOSTNAME="${1:-}"
PORT="${2:-5180}"
TUNNEL_NAME="crucible"

if [[ -z "$HOSTNAME" ]]; then
  echo "usage: $0 <hostname> [local-port]" >&2
  echo "   eg: $0 crucible.example.com 5180" >&2
  exit 2
fi

command -v cloudflared >/dev/null || { echo "cloudflared is not installed: brew install cloudflared" >&2; exit 1; }

# 1. Authorise this machine against the zone. Opens a browser; pick the domain.
if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
  echo "==> Authorising this machine with Cloudflare (a browser will open)"
  cloudflared tunnel login
fi

# 2. One tunnel, reused. Creating it twice is an error, so an existing one is kept.
if ! cloudflared tunnel list --name "$TUNNEL_NAME" --output json | grep -q '"id"'; then
  echo "==> Creating the tunnel '$TUNNEL_NAME'"
  cloudflared tunnel create "$TUNNEL_NAME"
else
  echo "==> Reusing the existing tunnel '$TUNNEL_NAME'"
fi

# 3. Point the hostname at it. Idempotent: re-running overwrites the DNS record.
echo "==> Routing https://$HOSTNAME to the tunnel"
cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME"

# 4. Run it. Keep this process alive for the whole event.
echo
echo "==> Starting. Leave this running."
echo "    Then set the two URLs so the QR codes match:"
echo "      event.register_url = https://$HOSTNAME/register"
echo "      event.submit_url   = https://$HOSTNAME/submit"
echo "    and start the web server with:"
echo "      VITE_WEB_HOST=0.0.0.0 VITE_WEB_ALLOWED_HOSTS=$HOSTNAME pnpm --filter @crucible/web exec vite preview"
echo
exec cloudflared tunnel run --url "http://127.0.0.1:$PORT" "$TUNNEL_NAME"
