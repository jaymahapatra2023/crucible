/**
 * Participants confirming their own details (migration 104).
 *
 * One public route and two organiser routes. The public one is on the allow-list and answers
 * with a fixed sentence; it never returns anything about the roster, which is what lets it be
 * public at all.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { decide, submitCorrection } from '../services/correctionService.js'
import { listCorrections, type CorrectionStatus } from '../db/correctionDb.js'

const claimBody = z.object({
  fullName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(320),
})

const idParams = z.object({ id: z.coerce.number().int().min(1) })
const decisionBody = z.object({ approve: z.boolean() })
const listQuery = z.object({
  status: z.enum(['PENDING', 'APPLIED', 'REJECTED']).optional(),
})

export async function registerCorrectionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public. Takes a name and an address, returns one sentence, reveals nothing.
   *
   * The reply is identical whether the name is on the list, is not, or is held by two people, so
   * the endpoint cannot be used to find out who is at the event.
   */
  app.post('/api/v1/confirm', async (req) =>
    ok(await submitCorrection(body(req, claimBody))),
  )

  /** The queue. Organiser only: it holds names and addresses. */
  app.get('/api/v1/roster/corrections', { preHandler: requireRole('organiser') }, async (req) => {
    const q = query(req, listQuery)
    return ok(await listCorrections(q.status as CorrectionStatus | undefined))
  })

  /** Approve or reject one. Approving corrects an existing row, or adds a new person. */
  app.post('/api/v1/roster/corrections/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    const input = body(req, decisionBody)
    return ok(await decide({
      correctionId: id, approve: input.approve, actor: principalOf(req).email,
    }))
  })
}
