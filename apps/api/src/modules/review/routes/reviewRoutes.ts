/**
 * Review and shortlist endpoints (E08).
 *
 * The authorisation split here is the epic's substance. A reviewer reads evidence and dismisses
 * caveats; only an organiser records a decision or locks the outcome. Reading who is near the
 * cut line and deciding who presents are different acts, and the API says so.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { dismissFlag, listFlags } from '../services/flagService.js'
import { reviewTable } from '../services/reviewTable.js'
import { teamDetail } from '../services/teamDetail.js'
import {
  decide, decisionHistory, finalise, openShortlist, reopen, shortlistState,
} from '../services/shortlistService.js'
import { exportShortlist } from '../services/shortlistExport.js'

const runParams = z.object({ id: z.coerce.number().int().min(1) })
const teamParams = z.object({
  id: z.coerce.number().int().min(1),
  submissionId: z.coerce.number().int().min(1),
})

const tableQuery = z.object({
  challengeId: z.coerce.number().int().min(1).optional(),
  flagCode: z.string().min(1).max(64).optional(),
  flaggedOnly: z.coerce.boolean().optional(),
  bandOnly: z.coerce.boolean().optional(),
  decision: z.enum(['SHORTLIST', 'EXCLUDE', 'HOLD']).optional(),
  missingDimension: z.string().min(1).max(40).optional(),
  sort: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

// Ten characters is the schema's floor and the database's; stated in both so the caller gets a
// useful 400 rather than a constraint violation translated after the fact.
const reasoned = z.string().trim().min(10).max(2000)

const decisionBody = z.object({
  submissionId: z.number().int().min(1),
  decision: z.enum(['SHORTLIST', 'EXCLUDE', 'HOLD']),
  reason: reasoned,
})

const dismissBody = z.object({
  submissionId: z.number().int().min(1),
  code: z.string().min(1).max(64),
  reason: reasoned,
})

export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  /** The ranked table, filtered and counted in the database (E08-S01, E08-S06). */
  app.get('/api/v1/review/runs/:id/table', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    const q = query(req, tableQuery)
    return ok(await reviewTable({
      runIndexId: id,
      filter: {
        challengeId: q.challengeId,
        flagCode: q.flagCode,
        flaggedOnly: q.flaggedOnly,
        bandOnly: q.bandOnly,
        decision: q.decision,
        missingDimension: q.missingDimension,
      },
      sort: q.sort,
      ...(q.limit !== undefined && { limit: q.limit }),
      ...(q.offset !== undefined && { offset: q.offset }),
    }))
  })

  /** Everything known about one team, including where the two runs disagree (E08-S02). */
  app.get('/api/v1/review/runs/:id/teams/:submissionId', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id, submissionId } = params(req, teamParams)
    return ok(await teamDetail(id, submissionId))
  })

  /** Every automated caveat for a run, or for one submission (E08-S03). */
  app.get('/api/v1/review/runs/:id/flags', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    const q = query(req, z.object({ submissionId: z.coerce.number().int().min(1).optional() }))
    const flags = await listFlags(id, q.submissionId)
    return ok({
      flags,
      open: flags.filter((f) => !f.dismissed).length,
      dismissed: flags.filter((f) => f.dismissed).length,
    })
  })

  /** Dismiss a caveat, with a reason (E08-S03 acceptance 3). */
  app.post('/api/v1/review/runs/:id/flags/dismiss', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    const input = body(req, dismissBody)
    return ok(await dismissFlag({
      runIndexId: id,
      submissionId: input.submissionId,
      code: input.code,
      actor: principalOf(req).email,
      reason: input.reason,
    }))
  })

  /** Open a shortlist against a ranked run. */
  app.post('/api/v1/review/runs/:id/shortlist', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, runParams)
    const input = body(req, z.object({ name: z.string().trim().max(200).default('') }))
    return ok(await openShortlist(id, principalOf(req).email, input.name))
  })

  app.get('/api/v1/review/runs/:id/shortlist', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    return ok(await shortlistState(id))
  })

  /**
   * Record a decision, or move a team between shortlist, hold and exclude (E08-S04, E23).
   *
   * Reviewer and above. It was organiser-only on the reasoning that reading the evidence and
   * deciding who presents are different acts — but the people who read the evidence are the
   * committee, and requiring an organiser to transcribe their conclusion puts a person between
   * the judgement and the record of it. The record carries whoever made it either way.
   *
   * Finalising the shortlist is still organiser-only: deciding about one team and closing the
   * whole list are the acts that genuinely differ.
   *
   * A move does not overwrite. The previous decision is superseded and kept (P7.1), because the
   * question an appeal asks is who decided what, in what order, and why.
   */
  app.post('/api/v1/review/runs/:id/decisions', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    const input = body(req, decisionBody)
    return ok(await decide({
      runIndexId: id,
      submissionId: input.submissionId,
      decision: input.decision,
      reason: input.reason,
      actor: principalOf(req).email,
    }))
  })

  /**
   * Every decision ever taken about one team, newest first (E23).
   *
   * Separate from the shortlist itself, which shows what STANDS. A reader asking why a team
   * moved is asking a different question from a reader asking where it ended up.
   */
  app.get('/api/v1/review/runs/:id/decisions/:submissionId/history',
    { preHandler: requireRole('reviewer') }, async (req) => {
      const { id, submissionId } = params(req, runParams.extend({
        submissionId: z.coerce.number().int().min(1),
      }))
      return ok(await decisionHistory(id, submissionId))
    })

  /** Lock the shortlist (E08-S05). Refused while the cut band is unresolved. */
  app.post('/api/v1/review/runs/:id/finalise', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, runParams)
    return ok(await finalise({ runIndexId: id, actor: principalOf(req).email }))
  })

  /** Reopen a locked shortlist — a recorded act, with a reason. */
  app.post('/api/v1/review/runs/:id/reopen', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, runParams)
    const input = body(req, z.object({ reason: reasoned }))
    return ok(await reopen({
      runIndexId: id, actor: principalOf(req).email, reason: input.reason,
    }))
  })

  /** The shortlist as CSV, with flags, overrides and reasons (E08-S05 acceptance 2). */
  app.get('/api/v1/review/runs/:id/shortlist.csv', { preHandler: requireRole('reviewer') }, async (req, reply) => {
    const { id } = params(req, runParams)
    const csv = await exportShortlist(id)
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="shortlist-run-${id}.csv"`)
      .send(csv)
  })
}
