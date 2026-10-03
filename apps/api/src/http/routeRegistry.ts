/**
 * Registry of every route the server actually mounted.
 *
 * Populated by a Fastify `onRoute` hook rather than by parsing `printRoutes()` output, whose
 * tree layout splits a path across indentation levels and silently yields trailing segments
 * instead of full paths.
 *
 * This exists so P8.1 can be *machine-checked*: a test enumerates what was really registered and
 * asserts each entry is either authenticated or explicitly allow-listed. Route coverage that is
 * derived from the router cannot drift from the router.
 */
import type { FastifyInstance } from 'fastify'

export interface RegisteredRoute {
  method: string
  url: string
}

const routes: RegisteredRoute[] = []

export function registerRouteRecorder(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      routes.push({ method, url: route.url })
    }
  })
}

/** Every mounted route, deduplicated. */
export function registeredRoutes(): RegisteredRoute[] {
  const seen = new Set<string>()
  return routes.filter((r) => {
    const key = `${r.method} ${r.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Test seam. */
export function clearRouteRegistry(): void {
  routes.length = 0
}
