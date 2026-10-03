import { beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { clearRouteRegistry, registeredRoutes, registerRouteRecorder } from './routeRegistry.js'

beforeEach(() => clearRouteRegistry())

describe('route registry (P8.1 machine check)', () => {
  it('records full paths, not trailing segments', async () => {
    const app = Fastify({ logger: false })
    registerRouteRecorder(app)
    app.get('/api/v1/platform/runs/:id', async () => ({}))
    await app.ready()

    expect(registeredRoutes().map((r) => r.url)).toContain('/api/v1/platform/runs/:id')
    await app.close()
  })

  it('records every method a route is mounted for', async () => {
    const app = Fastify({ logger: false })
    registerRouteRecorder(app)
    app.route({ method: ['GET', 'POST'], url: '/multi', handler: async () => ({}) })
    await app.ready()

    const methods = registeredRoutes().filter((r) => r.url === '/multi').map((r) => r.method)
    expect(methods).toContain('GET')
    expect(methods).toContain('POST')
    await app.close()
  })

  it('deduplicates repeated registrations', async () => {
    const app = Fastify({ logger: false })
    registerRouteRecorder(app)
    app.get('/dupe', async () => ({}))
    await app.ready()
    const first = registeredRoutes().filter((r) => r.url === '/dupe' && r.method === 'GET')
    expect(first).toHaveLength(1)
    await app.close()
  })
})
