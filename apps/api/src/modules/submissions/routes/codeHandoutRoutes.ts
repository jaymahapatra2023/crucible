/**
 * Handing every registered team its submission code, once (migration 103).
 *
 * Its own file rather than another route on `submissionRoutes`, which is already at its line
 * budget (P1.4), and its own concern: registration tells a team where to sit, this tells them
 * how to submit.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { handOutCodes } from '../services/codeHandout.js'

const handoutBody = z.object({
  /** False shows what would be sent and sends nothing — the same shape as every bulk path here. */
  confirm: z.boolean().default(false),
})

export async function registerCodeHandoutRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Organiser only, and deliberately a POST even for the dry run: it reads every registered
   * team's delivery state, which is not something a viewer should be able to enumerate.
   */
  app.post('/api/v1/submissions/codes/hand-out', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, handoutBody)
    return ok(await handOutCodes({ confirm: input.confirm, actor: principalOf(req).email }))
  })
}
