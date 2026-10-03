/**
 * Team administration (E47-S01, E48-S01).
 *
 * Two organiser acts on a team as an identity: correcting its name or contact, and replacing
 * its submission code. Both are audited; neither touches a submission — an entry keeps the name
 * it was made under (Part V.5), because the appeal packet cites it.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { reviseTeam } from '../services/teamService.js'
import { reissueSubmissionToken } from '../services/submissionTokens.js'
import { revealSubmissionToken } from '../services/tokenReveal.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })

const patchBody = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  contactEmail: z.string().trim().email().optional(),
})

const reissueBody = z.object({ reason: z.string().trim().min(3).max(500) })

export async function registerTeamRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/v1/submissions/teams/:id', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, idParams)
    const input = body(req, patchBody)
    if (input.displayName === undefined && input.contactEmail === undefined) {
      throw new AppError('VALIDATION_FAILED', 'Give a new name, a new contact address, or both.')
    }
    return ok(await reviseTeam({ teamId: id, ...input, actor: principalOf(req).email }))
  })

  /**
   * Replace a team's code (E47-S01). The response carries the new plaintext for the one moment
   * it exists — the same moment issuing has always had — and names the codes it stopped.
   */
  app.post('/api/v1/submissions/teams/:id/reissue', { preHandler: requireRole('organiser') },
    async (req, reply) => {
      const { id } = params(req, idParams)
      const input = body(req, reissueBody)
      const issued = await reissueSubmissionToken({
        teamId: id, reason: input.reason, actor: principalOf(req).email,
      })
      reply.status(201)
      return ok({ ...issued, revoked: issued.revokedTokenIds.length })
    })

  /**
   * Reveal a team's current code (E47-S02, ADR 0005). ADMIN only, audited before the plaintext
   * is opened, behind its own ceiling. A 200 that says `available: false` names why — a
   * deployment without the key, a purged copy, a revoked code — rather than failing.
   */
  app.post('/api/v1/submissions/tokens/:id/reveal', { preHandler: requireRole('admin') }, async (req) =>
    ok(await revealSubmissionToken(params(req, idParams).id, principalOf(req).email)),
  )
}
