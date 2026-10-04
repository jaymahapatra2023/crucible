/**
 * Discovery endpoints (E12).
 *
 * Running discovery is an organiser action and an explicit one: nothing triggers it as a side
 * effect of scanning or scoring, for the same reason nothing triggers a scan implicitly — seven
 * model calls per submission is a cost that should be chosen, not incurred.
 *
 * Reading it needs only `viewer`. A description of what a team built is exactly the kind of
 * thing every reviewer should see before they score it.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { discoverSubmission } from '../services/discoveryService.js'
import { discoveryView } from '../services/discoveryView.js'

const discoverBody = z.object({
  /** Re-describe even if this commit has already been described. Seven model calls. */
  force: z.boolean().default(false),
})
import {
  conflictsFor, dismissFinding, findingsFor, reinstateFinding,
} from '../db/discoveryDb.js'
import { diffLatest } from '../services/discoveryDiff.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { CONCERNS } from '../services/discoveryConcerns.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })

const KINDS = ['ENDPOINT', 'ENTITY', 'CAPABILITY', 'INTEGRATION', 'SECURITY', 'STACK'] as const
const findingsQuery = z.object({ kind: z.enum(KINDS).optional() })

/**
 * Why this observation is being set aside.
 *
 * Ten characters minimum, matching the table's own constraint. "ok" is not a reason, and a
 * reason nobody can read is the same as no reason at all.
 */
const dismissBody = z.object({
  reason: z.string().trim().min(10).max(2000),
})

export async function registerDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  /** What discovery asks about, so the UI names concerns from one declaration (P1.5). */
  app.get('/api/v1/discovery/concerns', { preHandler: requireRole('viewer') }, async () =>
    ok(CONCERNS.map((c) => ({
      key: c.key,
      name: c.target.name,
      description: c.target.description,
      kind: c.kind,
      emptyIsMeaningful: c.emptyIsMeaningful,
    }))),
  )

  /**
   * Describe a submission.
   *
   * Returns the existing description when the submission has already been described at this
   * commit, which is what the batch wants — but an organiser asking again usually means they
   * believe the description is wrong, so `force` is here for them. It is seven model calls, so
   * it is never the default.
   */
  app.post('/api/v1/submissions/:id/discovery', { preHandler: requireRole('organiser') },
    async (req, reply) => {
      const { id } = params(req, idParams)
      const input = req.body ? body(req, discoverBody) : { force: false }
      const outcome = await discoverSubmission({
        submissionId: id,
        actor: principalOf(req).email,
        force: input.force,
      })
      // 200 for a description that already existed, 201 for one that was just made. A caller
      // that spent nothing should not be told something was created.
      reply.code(outcome.reused ? 200 : 201)
      return ok(outcome)
    })

  /** Everything the discovery page renders, assembled server-side (E08-S06 honesty rules). */
  app.get('/api/v1/submissions/:id/discovery', { preHandler: requireRole('viewer') },
    async (req) => {
      const view = await discoveryView(params(req, idParams).id)
      if (view.status === 'ABSENT') {
        throw new AppError(
          'NOT_FOUND',
          `Submission ${params(req, idParams).id} has not been discovered. Run discovery on it ` +
            `first — nothing discovers implicitly.`,
        )
      }
      return ok(view)
    })

  app.get('/api/v1/submissions/:id/discovery/findings', { preHandler: requireRole('viewer') },
    async (req) => {
      const { kind } = query(req, findingsQuery)
      return ok(await findingsFor(params(req, idParams).id, kind))
    })

  app.get('/api/v1/submissions/:id/discovery/conflicts', { preHandler: requireRole('viewer') },
    async (req) => ok(await conflictsFor(params(req, idParams).id)))

  /** What changed since the discovery this one replaced (E16-S04). */
  app.get('/api/v1/submissions/:id/discovery/changes', { preHandler: requireRole('viewer') },
    async (req) => ok(await diffLatest(params(req, idParams).id)))

  /**
   * Set an observation aside, having checked it.
   *
   * A reviewer action, so `reviewer` rather than `organiser`: judging whether a flagged pattern
   * is benign is exactly what a reviewer is for. The reason is mandatory and enforced by the
   * table, not here — a service check is one the next caller can route around.
   */
  app.post('/api/v1/discovery/findings/:id/dismiss', { preHandler: requireRole('reviewer') },
    async (req) => {
      const { id } = params(req, idParams)
      const { reason } = body(req, dismissBody)
      const actor = principalOf(req).email

      const { submissionId } = await dismissFinding({ findingId: id, reason, actor })
      await recordAudit({
        actor, action: 'discovery.observation_dismissed',
        subjectType: 'submission', subjectId: String(submissionId),
        payload: { findingId: id, reason },
      })
      return ok({ findingId: id, dismissed: true, reason })
    })

  /** Put one back. Itself a decision, so it is audited like the dismissal was. */
  app.post('/api/v1/discovery/findings/:id/reinstate', { preHandler: requireRole('reviewer') },
    async (req) => {
      const { id } = params(req, idParams)
      const actor = principalOf(req).email
      const undone = await reinstateFinding(id, actor)
      if (!undone) {
        throw new AppError(
          'NOT_FOUND',
          `Finding ${id} is not currently set aside, so there is nothing to reinstate.`)
      }
      await recordAudit({
        actor, action: 'discovery.observation_reinstated',
        subjectType: 'discovery_finding', subjectId: String(id), payload: {},
      })
      return ok({ findingId: id, dismissed: false })
    })
}
