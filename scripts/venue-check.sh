#!/usr/bin/env bash
#
# Run this on the venue network before the doors open. It answers one question: which way can
# participants reach Crucible from here?
#
# Why it exists: on 2 October 2026 the tunnel worked, then stopped, with a Cloudflare 530 and a
# perfectly healthy local server. The cause was the network blocking outbound port 7844, which
# cloudflared requires and which nothing else uses — so every ordinary connectivity test passed
# while the tunnel could not connect at all. That is a five minute diagnosis if you know to look
# and an hour if you do not.
set -uo pipefail

HOSTNAME="${1:-codelinc-lfg.com}"
WEB_PORT="${2:-5180}"
EDGE=region1.v2.argotunnel.com

ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mNO\033[0m    %s\n' "$1"; }
info() { printf '        %s\n' "$1"; }

echo
echo "Crucible venue check — $(date '+%Y-%m-%d %H:%M')"
echo

# 1. This machine's address, which participants would type if the tunnel is unavailable.
IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
LAN=$(ipconfig getifaddr "${IFACE:-en0}" 2>/dev/null || echo '')
if [[ -n "$LAN" ]]; then
  ok "this machine is $LAN on $IFACE"
  info "LAN fallback: http://$LAN:$WEB_PORT  (write this on the whiteboard)"
else
  bad "no IPv4 address on the default interface — not on a network"
fi

# 2. The local stack.
for pair in "web:http://127.0.0.1:$WEB_PORT/" "api:http://127.0.0.1:3101/ready"; do
  name="${pair%%:*}"; url="${pair#*:}"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
  [[ "$code" == "200" ]] && ok "$name is serving locally" || bad "$name returned ${code:-no response}"
done

# 3. Plain internet. Separates "no internet" from "internet but the tunnel port is blocked".
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://dash.cloudflare.com/ 2>/dev/null)
[[ -n "$code" && "$code" != "000" ]] && ok "the internet is reachable" || bad "no internet at all"

# 4. THE ONE THAT MATTERS. cloudflared needs outbound 7844; nothing else does, so a network can
#    look perfect and still refuse it.
if nc -zv -G 6 "$EDGE" 7844 >/dev/null 2>&1; then
  ok "outbound port 7844 is open — the tunnel can connect"
else
  bad "outbound port 7844 is BLOCKED — the tunnel cannot connect from this network"
  info "Every other check above can pass while this fails. Use the LAN address, or a"
  info "guest network / phone hotspot that does not filter it."
fi

# 5. End to end, which is the only proof that counts.
for path in / /register /submit; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$HOSTNAME$path" 2>/dev/null)
  if [[ "$code" == "200" ]]; then
    ok "https://$HOSTNAME$path"
  elif [[ "$code" == "530" ]]; then
    bad "https://$HOSTNAME$path returned 530 — Cloudflare has the DNS but no tunnel connection"
  else
    bad "https://$HOSTNAME$path returned ${code:-no response}"
  fi
done

echo
echo "Tunnel process: $(pgrep -f cloudflared | wc -l | tr -d ' ')   (the LaunchAgent restarts it)"
echo "Recent tunnel errors: $(tail -50 /tmp/crucible-tunnel.log 2>/dev/null | grep -c ERR)"
echo
