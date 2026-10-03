/**
 * Build probe endpoints (E05-S04, E05-S05).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, pageMeta, paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import {
  countProbes, listProbes, probeHealth, selectCurrentProbe, selectProbe, selectProbeLog,
} from '../db/probeDb.js'
import { currentPolicy, probeSubmission } from '../services/probeService.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })
const probeBody = z.object({ force: z.boolean().default(false) })

export async function registerProbeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/probes', { preHandler: requireRole('viewer') }, async (req) => {
    const q = query(req, paginationQuerySchema)
    const { limit, offset } = toLimitOffset(q)
    const [probes, total] = await Promise.all([listProbes(limit, offset), countProbes()])
    return ok(probes, pageMeta(total, q.page, q.pageSize))
  })

  app.get('/api/v1/probes/health', { preHandler: requireRole('viewer') }, async () =>
    ok(await probeHealth()),
  )

  /** The sandbox policy currently in force — readable so the controls can be inspected (P8.6). */
  app.get('/api/v1/probes/policy', { preHandler: requireRole('viewer') }, async () =>
    ok(await currentPolicy()),
  )

  app.get('/api/v1/probes/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    const probe = await selectProbe(id)
    if (!probe) throw new AppError('NOT_FOUND', `Probe ${id} was not found.`)
    return ok(probe)
  })

  /**
   * The build log (E05-S05).
   *
   * Restricted to `reviewer` and above, and **audited on every read** (acceptance 2): the log is
   * the only way to tell a broken submission from a broken prober, and who looked at a team's
   * build output is itself part of the record.
   */
  app.get('/api/v1/probes/:id/log', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, idParams)
    const log = await selectProbeLog(id)
    if (!log) throw new AppError('NOT_FOUND', `Probe ${id} was not found.`)

    await recordAudit({
      actor: principalOf(req).email,
      action: 'probes.log_viewed',
      subjectType: 'build_probe',
      subjectId: String(id),
      payload: { submissionId: log.submissionId, bytes: log.logBytes },
    })
    return ok(log)
  })

  app.post('/api/v1/submissions/:id/probe', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const { id } = params(req, idParams)
    const input = req.body ? body(req, probeBody) : { force: false }
    const outcome = await probeSubmission({
      submissionId: id, force: input.force, actor: principalOf(req).email,
    })
    reply.status(outcome.skipped ? 200 : 201)
    return ok(outcome)
  })

  app.get('/api/v1/submissions/:id/probe', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    const probe = await selectCurrentProbe(id)
    if (!probe) throw new AppError('NOT_FOUND', `Submission ${id} has not been probed yet.`)
    return ok(probe)
  })
}
