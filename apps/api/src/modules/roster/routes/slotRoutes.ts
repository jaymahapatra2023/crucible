/**
 * Pre-provisioned team slots (migration 095).
 *
 * Split from `rosterRoutes.ts` by subject: that file runs the roster of people, rooms and
 * coaches; this one provisions the floor plan they are arranged into.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { provisionSlots, slotStatus } from '../services/slotService.js'
import { listSlots } from '../db/slotDb.js'

export async function registerSlotRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Provision the floor plan: a slot per team, each with its room and coach.
   *
   * Two steps like every other bulk path. Without `confirm` it reports what the file would do and
   * writes nothing; a file with any unusable row is refused whole rather than half-applied.
   */
  app.post('/api/v1/roster/slots', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, z.object({
      csv: z.string().min(1).max(200_000),
      confirm: z.boolean().default(false),
    }))
    return ok(await provisionSlots({ ...input, actor: principalOf(req).email }))
  })

  /** Where the pool stands: provisioned, claimed, and what is left. */
  app.get('/api/v1/roster/slots', { preHandler: requireRole('viewer') }, async () =>
    ok({ status: await slotStatus(), slots: await listSlots() }),
  )
}
