/**
 * Audit log endpoints (E09-S01).
 *
 * Read-only by construction: there is no update or delete route, and the database refuses those
 * operations anyway (migration 003). Access is restricted to `organiser` and above — the trail
 * records who did what and is not general reading.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, pageMeta, paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import { params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { auditTrailFor, listAudit } from '../services/auditService.js'
import { appealPacket } from '../services/appealPacket.js'

const auditQuery = paginationQuerySchema.extend({
  subjectType: z.string().min(1).max(60).optional(),
  subjectId: z.string().min(1).max(200).optional(),
  actor: z.string().min(1).max(320).optional(),
  action: z.string().min(1).max(120).optional(),
})

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/governance/audit', { preHandler: requireRole('organiser') }, async (req) => {
    const q = query(req, auditQuery)
    const { limit, offset } = toLimitOffset(q)
    const { events, total } = await listAudit(
      {
        ...(q.subjectType && { subjectType: q.subjectType }),
        ...(q.subjectId && { subjectId: q.subjectId }),
        ...(q.actor && { actor: q.actor }),
        ...(q.action && { action: q.action }),
      },
      limit,
      offset,
    )
    return ok(events, pageMeta(total, q.page, q.pageSize))
  })

  /** The whole recorded history of one subject, oldest last. */
  app.get('/api/v1/governance/audit/:subjectType/:subjectId', { preHandler: requireRole('organiser') }, async (req) => {
    const p = params(req, z.object({
      subjectType: z.string().min(1).max(60),
      subjectId: z.string().min(1).max(200),
    }))
    return ok(await auditTrailFor(p.subjectType, p.subjectId))
  })

  /**
   * The appeal packet for one team (E09-S02).
   *
   * Organiser and above: it contains another team's full evaluation, including rationales and
   * source excerpts. Generating one is itself audited (acceptance 3), which is why this is a
   * handler and not a static file.
   */
  app.get('/api/v1/governance/runs/:runId/appeal/:submissionId', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const p = params(req, z.object({
      runId: z.coerce.number().int().min(1),
      submissionId: z.coerce.number().int().min(1),
    }))

    const document = await appealPacket({
      runIndexId: p.runId,
      submissionId: p.submissionId,
      actor: principalOf(req).email,
    })

    return reply
      .type('text/markdown; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="appeal-run-${p.runId}-submission-${p.submissionId}.md"`)
      .send(document)
  })
}
