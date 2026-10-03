/**
 * P8.1 enforcement test.
 *
 * The principles doc says a principle a reviewer can falsify by reading the router is worse than
 * no principle. This test makes the router prove it: every route Fastify has actually
 * registered must either require authentication or appear on the declared allow-list.
 *
 * A new route that is public by accident of mount ordering fails here, by name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isPublicRoute, PUBLIC_ROUTES } from '../../src/http/auth.js'
import { registeredRoutes, type RegisteredRoute } from '../../src/http/routeRegistry.js'
import { closeApp, getApp } from '../support/testServer.js'
import { buildServer } from '../../src/server.js'
import { resetDatabase } from '../setup/integrationSetup.js'

let routes: RegisteredRoute[] = []

beforeAll(async () => {
  await resetDatabase()
  const app = await getApp()
  await app.ready()
  routes = registeredRoutes()
})

afterAll(async () => closeApp())

describe('P8.1 — authenticate every request', () => {
  it('discovered the registered routes', () => {
    expect(routes.length).toBeGreaterThan(5)
  })

  it('every registered route is either authenticated or explicitly allow-listed', async () => {
    const app = await getApp()
    const unprotected: string[] = []

    for (const route of routes) {
      if (route.method === 'HEAD' || route.method === 'OPTIONS') continue
      if (isPublicRoute(route.method, route.url)) continue
      // Substitute a value for path parameters so routing resolves.
      const url = route.url.replace(/:[A-Za-z0-9_]+/g, '1').replace(/\/\*$/, '/x')

      const res = await app.inject({ method: route.method as 'GET', url, payload: {} })
      // 404 counts as a failure too: it means the route exists but this check could not reach
      // it, so the check would be silently proving nothing.
      if (res.statusCode !== 401) {
        unprotected.push(`${route.method} ${route.url} → ${res.statusCode} (expected 401)`)
      }
    }

    expect(unprotected, 'Routes reachable without authentication and not on the P8.1 allow-list').toEqual([])
  })

  it('the allow-list is exactly what the principles doc declares', () => {
    // A route is public only by appearing here, so widening the allow-list must be a conscious
    // act that also updates P8.1. Pinning the exact set is what forces that: silently adding an
    // entry fails this test by name.
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      'GET /api/v1/challenges/open',
      'GET /api/v1/register/*',
      'GET /api/v1/rubrics/published/*',
      'GET /api/v1/submissions/mine',
      'GET /api/v1/submissions/status',
      'GET /health',
      'GET /metrics',
      'GET /ready',
      'GET /ws/progress',
      'POST /api/v1/auth/login',
      'POST /api/v1/register/*',
      'POST /api/v1/register/start',
      'POST /api/v1/submissions',
    ])
  })

  it('every allow-listed route that is not a wildcard actually exists', () => {
    // The inverse failure: an allow-list entry for a route never built, which makes the
    // principles doc claim something untrue.
    const registered = new Set(routes.map((r) => r.url))
    for (const entry of PUBLIC_ROUTES) {
      const path = entry.split(' ')[1] as string
      if (path.endsWith('/*')) continue
      expect(registered.has(path), `${entry} is allow-listed but not registered`).toBe(true)
    }
  })

  it('a new route is protected by default — auth is a global hook, not per-route opt-in', async () => {
    // The structural property P8.1 depends on: a route added without any auth wiring is still
    // rejected, because the allow-list is the only way to become public.
    const fresh = await buildServer({ quiet: true, withoutJobs: true })
    fresh.get('/api/v1/platform/newly-added-route', async () => ({ data: 'secret' }))
    await fresh.ready()
    const res = await fresh.inject({ method: 'GET', url: '/api/v1/platform/newly-added-route' })
    await fresh.close()
    expect(res.statusCode).toBe(401)
  })

  it('a public POST path does NOT make the same path public for GET', async () => {
    // POST /api/v1/submissions is a team submitting with a token. GET on the same path lists
    // every team's name, contact and repository — and must stay authenticated.
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/submissions' })
    expect(res.statusCode).toBe(401)
  })

  it('public routes really are reachable without a token', async () => {
    const app = await getApp()
    for (const url of ['/health', '/ready']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
    }
  })

  it('rejects a malformed Authorization header', async () => {
    const app = await getApp()
    for (const authorization of ['', 'Basic abc', 'Bearer', 'bearer x', 'Bearer not.a.token']) {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/platform/runs', headers: { authorization },
      })
      expect(res.statusCode, authorization).toBe(401)
    }
  })
})
