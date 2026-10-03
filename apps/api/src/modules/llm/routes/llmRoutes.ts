/**
 * LLM observability and registry endpoints (P9.3).
 *
 * There is deliberately no endpoint that invokes a model directly. Calls originate from the
 * module that owns the use case, through the gateway with its registered call key — an
 * "ad-hoc prompt" endpoint would be an unregistered, unaudited call site (P3.1/P3.2).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { query } from '../../../http/validate.js'
import { requireRole } from '../../../http/auth.js'
import { selectAllRegistrations } from '../db/llmRegistryDb.js'
import { selectCallKeyMetrics } from '../db/llmCallLogDb.js'
import { listProviders } from '../providers/providerRegistry.js'

const metricsQuery = z.object({
  sinceHours: z.coerce.number().int().min(1).max(720).default(24),
})

export async function registerLlmRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/llm/registry', { preHandler: requireRole('viewer') }, async () =>
    ok(await selectAllRegistrations()),
  )

  app.get('/api/v1/llm/metrics', { preHandler: requireRole('viewer') }, async (req) => {
    const q = query(req, metricsQuery)
    return ok(await selectCallKeyMetrics(q.sinceHours), { sinceHours: q.sinceHours })
  })

  app.get('/api/v1/llm/providers', { preHandler: requireRole('viewer') }, async () =>
    ok(listProviders()),
  )
}
