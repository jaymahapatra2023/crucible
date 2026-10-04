/**
 * Coaches confirming they are at the venue (migration 105).
 *
 * Two public routes and one organiser route. The public pair offer the coach NAMES and take a
 * tap; neither returns an address, an organisation or anything about teams.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body } from '../../../http/validate.js'
import { requireRole } from '../../../http/auth.js'
import { arrivalState, confirmArrival } from '../services/arrivalService.js'
import { listCoachNames } from '../db/arrivalDb.js'

const confirmBody = z.object({ fullName: z.string().trim().min(2).max(200) })

export async function registerArrivalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The names the page offers. Names ONLY — a coach's name is already on the door of the room
   * they are coaching in, their address is not, and this page has no use for it.
   */
  app.get('/api/v1/coach/names', async () => ok(await listCoachNames()))

  /** One tap. Returns the same sentence whether the name matched or not. */
  app.post('/api/v1/coach/confirm', async (req) =>
    ok(await confirmArrival(body(req, confirmBody))),
  )

  /**
   * Who is here and, more usefully, how many teams have nobody. Organiser only: it carries
   * addresses and team counts.
   */
  app.get('/api/v1/roster/arrivals', { preHandler: requireRole('organiser') }, async () =>
    ok(await arrivalState()),
  )
}
