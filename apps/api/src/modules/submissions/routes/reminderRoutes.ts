/**
 * Chasing teams before the deadline (E50).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { chaseList, sendReminders } from '../services/reminderService.js'

const remindBody = z.object({ teamIds: z.array(z.number().int().min(1)).max(500).optional() })

export async function registerReminderRoutes(app: FastifyInstance): Promise<void> {
  /** Who has not submitted, or has unfixed problems, with the last reminder each was sent. */
  app.get('/api/v1/submissions/reminders', { preHandler: requireRole('viewer') }, async () =>
    ok(await chaseList()),
  )

  /** Remind the listed teams, or everybody on the list. Organiser-only; each message recorded. */
  app.post('/api/v1/submissions/reminders', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = req.body ? body(req, remindBody) : {}
    reply.status(201)
    return ok(await sendReminders({ actor: principalOf(req).email, ...(input.teamIds && { teamIds: input.teamIds }) }))
  })
}
