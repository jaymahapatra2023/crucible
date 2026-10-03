/**
 * Run ledger endpoints (E01-S05 acceptance 3, P6.1–P6.3).
 *
 * Thin: parse, delegate, envelope. All logic is in the service (P1.2).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, pageMeta, paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import { params, query } from '../../../http/validate.js'
import { requireRole } from '../../../http/auth.js'
import { readinessReport } from '../services/readinessReport.js'
import { getRunDetail, getRuns } from '../services/runLedgerService.js'
import { RUN_KINDS } from '../types/runTypes.js'

const listQuery = paginationQuerySchema.extend({
  kind: z.enum(RUN_KINDS).optional(),
})

const runIdParams = z.object({ id: z.coerce.number().int().min(1) })

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The system-level definition of done (plan §IV.5).
   *
   * Seven statements checked against the database. Readable by any signed-in user: whether this
   * system is fit to decide is not privileged information, and a reviewer looking at a shortlist
   * is entitled to know.
   */
  app.get('/api/v1/platform/readiness/:cohortKey', { preHandler: requireRole('viewer') }, async (req) => {
    const p = params(req, z.object({ cohortKey: z.string().min(1).max(200) }))
    return ok(await readinessReport(p.cohortKey))
  })

  app.get('/api/v1/platform/runs', { preHandler: requireRole('viewer') }, async (req) => {
    const q = query(req, listQuery)
    const { limit, offset } = toLimitOffset(q)
    const { runs, total } = await getRuns(limit, offset, q.kind)
    return ok(runs, pageMeta(total, q.page, q.pageSize))
  })

  app.get('/api/v1/platform/runs/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, runIdParams)
    // Current state without reading logs — E01-S05 acceptance 3.
    return ok(await getRunDetail(id))
  })
}
