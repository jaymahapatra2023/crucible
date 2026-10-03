import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** The API port is configurable so the E2E harness can run the stack on its own ports. */
const apiPort = process.env['VITE_API_PORT'] ?? '3101'
/** 5180 rather than Vite's 5173: this machine runs other Vite apps, and a port collision on
 * `localhost` silently serves the wrong application. `strictPort` makes a collision fail loudly. */
const webPort = Number(process.env['VITE_WEB_PORT'] ?? '5180')

/**
 * Which interfaces to listen on.
 *
 * 127.0.0.1 by default, so a laptop does not quietly expose a development server to whatever
 * network it is on. `VITE_WEB_HOST=0.0.0.0` opens it deliberately — what the event needs when
 * participants are reaching it over the venue WiFi.
 */
const webHost = process.env['VITE_WEB_HOST'] ?? '127.0.0.1'

/**
 * Hostnames this server will answer to, beyond localhost and the LAN address.
 *
 * Vite refuses a request whose `Host` header it does not recognise, and it is right to: a page
 * on some other site can make a browser on this network ask `http://127.0.0.1:5180` for the
 * app, and without the check it would get it. Reaching Crucible through a tunnel means the
 * `Host` header is the tunnel's name, so that name has to be named here.
 *
 * Comma-separated. A leading dot is a suffix match, so `.trycloudflare.com` covers whatever
 * name a quick tunnel is given this time without an edit on the morning of the event.
 */
const allowedHosts = (process.env['VITE_WEB_ALLOWED_HOSTS'] ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h.length > 0)

/**
 * `/api` is proxied in BOTH the dev server and `vite preview`.
 *
 * Preview serves the built bundle, which is what participants should be given: minified, no
 * hot-reload socket per client, no source on the wire. It needs the same proxy as dev or every
 * API call from a built page would 404.
 */
const proxy = {
  '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
  '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
}

/*
 * `/health` and `/ready` are NOT proxied, and must not be.
 *
 * They were, briefly, so that a health check over the tunnel could reach the API without an
 * `/api` prefix. That shadowed the web app's own `/health` page: the browser asked for it, the
 * proxy answered with the API's JSON, and the operator's health screen became the text
 * `{"data":{"status":"ok"}}`. The web app owns its URL space. Probe the API on its own port, or
 * through `/api`.
 */

/** Vite config. The API base is proxied in dev so the web app never hardcodes a host. */
export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    // Bind IPv4 explicitly. Vite's default `localhost` resolves to ::1 on macOS, so anything
    // reaching for 127.0.0.1 — curl, a health check, Playwright's readiness probe — sees a
    // refused connection and concludes the dev server never started.
    host: webHost,
    proxy,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  },
  preview: {
    port: webPort,
    strictPort: true,
    host: webHost,
    proxy,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  },
  build: { outDir: 'dist', sourcemap: true },
})
