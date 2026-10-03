/**
 * Pre-flight endpoints (E46-S02 acceptance 2 and 4).
 *
 * Triggering is an organiser's act and answers 202: the run is queued, not done. Reading is for
 * any signed-in role — the intake screen shows progress per submission.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import {
  enqueuePreflight, getPreflight, latestPreflight,
} from '../services/preflightOrchestrator.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })
const runBody = z.object({ force: z.boolean().default(false) })

export async function registerPreflightRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/preflight/submissions/:id/run', { preHandler: requireRole('organiser') },
    async (req, reply) => {
      const { id } = params(req, idParams)
      const input = req.body ? body(req, runBody) : { force: false }
      const outcome = await enqueuePreflight({
        submissionId: id, triggeredBy: principalOf(req).email, force: input.force,
      })
      reply.status(202)
      return ok({
        preflightId: outcome.run.preflightId, status: outcome.run.status, joined: outcome.joined,
        message: outcome.joined
          ? `Checks are already ${outcome.run.status === 'RUNNING' ? 'running' : 'queued'} for this entry; this request joined them.`
          : 'Checks queued. The result appears on the entry when they finish, and the team is emailed.',
      })
    })

  app.get('/api/v1/preflight/submissions/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    const view = await latestPreflight(id)
    if (!view) throw new AppError('NOT_FOUND', `Submission ${id} has not been pre-flighted yet.`)
    return ok(view)
  })

  app.get('/api/v1/preflight/runs/:id', { preHandler: requireRole('viewer') }, async (req) =>
    ok(await getPreflight(params(req, idParams).id)),
  )
}
