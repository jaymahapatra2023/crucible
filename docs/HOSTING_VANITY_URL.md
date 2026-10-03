# A vanity URL for the event

> **Done for codeLinc 11.** The event is served at **https://codelinc-lfg.com**, a named
> Cloudflare tunnel on a domain registered through Cloudflare Registrar. The hostname does not
> change, across restarts or revocation. A LaunchAgent (`~/Library/LaunchAgents/
> com.crucible.tunnel.plist`) restarts the tunnel if it dies; verified by killing it. The rest of
> this document is the reasoning and the steps, kept for next year.

The quick tunnel works but is not something to print. It takes a random hostname, takes a new one
on every restart, and Cloudflare can revoke it while the process keeps running and looking
healthy. On 2 October 2026 it did exactly that after about an hour. Crucible renders the
registration and submission QR codes from `event.register_url` and `event.submit_url`, so a
rotating hostname silently invalidates anything already handed out.

## The failure that looks like nothing else

`cloudflared` needs outbound port **7844**, TCP or UDP. Nothing else on a machine uses that port,
so a network can pass every ordinary test — DNS, HTTPS, ping, a browser — and still refuse the
tunnel completely. The symptom is a Cloudflare **530** on the hostname while the local server
answers 200, which reads like an application fault and is not one.

Proof, measured on 2 October 2026 after moving networks:

```
198.41.192.57:443    open
198.41.192.57:7844   timed out      (same host, same moment)
github.com           200
127.0.0.1:5180       200
```

Run `scripts/venue-check.sh` before the doors open. It tests that port specifically, prints the
LAN fallback address, and distinguishes 530 from every other failure. The LaunchAgent keeps
retrying, so the site comes back by itself the moment the port is reachable.

If the venue blocks 7844 there is no Cloudflare-side workaround: the port is not configurable.
The options are the LAN address, a network that does not filter it, or a tunnel that runs over
443, which means ngrok or Tailscale Funnel and their own hostnames rather than yours.

## What a vanity hostname needs

A domain in a Cloudflare account. There is no way around this one: `cloudflared tunnel login`
asks which zone to authorise, and with no zone there is nothing to authorise. Free subdomain
services do not help, because the laptop is behind NAT and only a tunnel can reach it.

Shorteners are not an alternative. is.gd, v.gd and TinyURL all refuse `trycloudflare.com`
outright, because ephemeral tunnel domains are a phishing vector. A short link also cannot be
edited after the fact on the free tiers, so it dies with the hostname it was made for.

## The 20 minute path

1. Buy a domain at any registrar. Cloudflare's own registrar sells at cost.
2. Add it to Cloudflare (the free plan is enough) and point the registrar at Cloudflare's
   nameservers. Propagation is usually minutes.
3. Run the script, which authorises the machine, creates one reusable tunnel, routes the hostname
   and starts serving:

   ```
   scripts/named-tunnel.sh crucible.example.com
   ```

4. Set the two URLs so the emails and the QR codes agree:

   ```
   event.register_url = https://crucible.example.com/register
   event.submit_url   = https://crucible.example.com/submit
   ```

5. Start the web server allowing that hostname. Vite refuses an unrecognised `Host` header, and
   it is right to:

   ```
   VITE_WEB_HOST=0.0.0.0 VITE_WEB_ALLOWED_HOSTS=crucible.example.com \
     pnpm --filter @crucible/web exec vite preview
   ```

The hostname then survives restarts, so nothing has to be re-pointed again.

## If no domain is available in time

Show the QR codes on screen from the Intake page and write the LAN address on a whiteboard. The
length of the tunnel URL does not matter to anybody who scans rather than types, which is
everybody.

A Cloudflare Worker is the middle option: a free account gives a stable `*.workers.dev` address
whose destination you can edit in seconds, so printed codes keep working across a tunnel
rotation. It is a redirect, not a tunnel, so the quick tunnel is still what serves the app.
