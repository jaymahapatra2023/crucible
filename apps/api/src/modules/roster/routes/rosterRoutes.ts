/**
 * Roster endpoints (E27).
 *
 * Organiser and above, all of them. A participant list is 200 people's names and addresses; it is
 * not on the P8.1 allow-list and a viewer has no business reading it.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import {
  countParticipants, listParticipants, selectParticipant,
} from '../db/rosterDb.js'
import { PARTICIPANT_SORTS } from '../db/participantQuery.js'
import { paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import {
  addCoach, addParticipant, addRoom, assignLogistics, getCoaches, getLogistics, getRooms,
  removeParticipant, reviseCoach, reviseParticipant, reviseRoom,
} from '../services/rosterService.js'
import { importRoster, ROSTER_KINDS } from '../services/rosterImport.js'
import {
  assign, createTeam, move, rosterBoard, setContact, unassign,
} from '../services/membershipService.js'
import { rosterReadiness } from '../services/rosterReadiness.js'
import { DELETE_REASONS } from '../types/rosterTypes.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })

/**
 * Paging, ordering and search for the participant list (E40).
 *
 * `sort` is validated against the allow-list rather than passed through: an unknown key is
 * REFUSED, not silently defaulted, because a sort that quietly does nothing looks exactly like a
 * sort that worked and found this order.
 */
const participantQuery = paginationQuerySchema.extend({
  sort: z.enum(PARTICIPANT_SORTS as [string, ...string[]]).optional(),
  search: z.string().trim().min(1).max(200).optional(),
})

const importBody = z.object({
  kind: z.enum(ROSTER_KINDS),
  csv: z.string().min(1).max(524_288),
  confirm: z.boolean().default(false),
})

/**
 * A field absent means "leave it alone"; `null` means "clear it".
 *
 * `.nullable().optional()` rather than `.optional()` because a screen that sends the whole object
 * on every save would otherwise be unable to clear an organisation it had set.
 */
const participantBody = z.object({
  fullName: z.string().min(2).max(200).optional(),
  email: z.string().email().max(320).optional(),
  organisation: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  notes: z.string().max(2000).optional(),
  /** As typed; resolved against the event server when a bot is configured (E49). */
  discordUsername: z.string().trim().max(64).nullable().optional(),
})

/**
 * Adding one record by hand (E31-S01).
 *
 * Separate schemas from the edit bodies above, because the rules differ: on a create, a name and
 * an address are required, and on an edit every field is optional so a screen can send only what
 * the operator touched.
 */
const newParticipantBody = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(320),
  organisation: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  notes: z.string().max(2000).optional(),
  discordUsername: z.string().trim().max(64).nullable().optional(),
})

const newRoomBody = z.object({
  label: z.string().min(1).max(120),
  location: z.string().max(200).optional(),
  /** People. */
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
  /** Teams, independent of the people figure (migration 101). */
  teamCapacity: z.number().int().min(1).max(200).nullable().optional(),
})

const newCoachBody = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(320),
  organisation: z.string().max(200).nullable().optional(),
  /** How many teams they agreed to take (migration 102). */
  teamCapacity: z.number().int().min(1).max(20).nullable().optional(),
})

const roomBody = z.object({
  label: z.string().min(1).max(120).optional(),
  location: z.string().max(200).optional(),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
  teamCapacity: z.number().int().min(1).max(200).nullable().optional(),
  inUse: z.boolean().optional(),
})

const coachBody = z.object({
  fullName: z.string().min(2).max(200).optional(),
  email: z.string().email().max(320).optional(),
  organisation: z.string().max(200).nullable().optional(),
  active: z.boolean().optional(),
  teamCapacity: z.number().int().min(1).max(20).nullable().optional(),
})

const memberBody = z.object({
  participantId: z.number().int().min(1),
  /** Take them off whatever team they are on first, rather than being refused. */
  move: z.boolean().optional(),
  asContact: z.boolean().optional(),
})

/**
 * `participantId` names the team's first member, who becomes its point of contact.
 *
 * Optional, because a team is sometimes created before anybody is on it — but then the team has
 * no contact address, which `GET /roster/readiness` reports by name.
 */
const teamBody = z.object({
  displayName: z.string().min(2).max(200),
  participantId: z.number().int().min(1).optional(),
})

const logisticsBody = z.object({
  roomId: z.number().int().min(1).nullable().optional(),
  coachId: z.number().int().min(1).nullable().optional(),
})

export async function registerRosterRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Load a list from a file (E27-S01, E27-S02).
   *
   * `confirm: false` returns the plan and writes nothing, so 200 rows can be looked at before
   * any of them exists. `confirm: true` writes, and refuses the whole file if any row cannot be
   * acted on.
   */
  app.post('/api/v1/roster/import', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, importBody)
    return ok(await importRoster({ ...input, actor: principalOf(req).email }))
  })

  // ── Participants ────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/roster/participants', { preHandler: requireRole('organiser') }, async (req) => {
    const q = query(req, participantQuery)
    const { limit, offset } = toLimitOffset(q)
    const filter = q.search !== undefined ? { search: q.search } : {}
    // The real backend count beside a bounded page (P5.7): "200 participants" has to be the
    // number matching the filter, not the number this response happened to carry.
    return ok({
      participants: await listParticipants(limit, offset, q.sort, filter),
      total: await countParticipants(filter),
    })
  })

  /** Add one by hand — the person who registered on the morning (E31-S01). */
  app.post('/api/v1/roster/participants', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const created = await addParticipant({
      ...body(req, newParticipantBody), actor: principalOf(req).email,
    })
    reply.status(201)
    return ok(created)
  })

  app.get('/api/v1/roster/participants/:id', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await selectParticipant(params(req, idParams).id)),
  )

  app.patch('/api/v1/roster/participants/:id', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await reviseParticipant({
      participantId: params(req, idParams).id,
      ...body(req, participantBody),
      actor: principalOf(req).email,
    })),
  )

  /** Soft delete with a reason (P7.4). Nothing here removes a person from the record. */
  app.delete('/api/v1/roster/participants/:id', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const q = query(req, z.object({ reason: z.enum(DELETE_REASONS).default('ADMIN_ACTION') }))
    await removeParticipant({
      participantId: params(req, idParams).id, reason: q.reason,
      actor: principalOf(req).email,
    })
    reply.status(204)
    return null
  })

  // ── Rooms and coaches ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/roster/rooms', { preHandler: requireRole('organiser') }, async () =>
    ok(await getRooms()),
  )

  app.post('/api/v1/roster/rooms', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const created = await addRoom({ ...body(req, newRoomBody), actor: principalOf(req).email })
    reply.status(201)
    return ok(created)
  })

  app.patch('/api/v1/roster/rooms/:id', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await reviseRoom({
      roomId: params(req, idParams).id, ...body(req, roomBody), actor: principalOf(req).email,
    })),
  )

  app.get('/api/v1/roster/coaches', { preHandler: requireRole('organiser') }, async () =>
    ok(await getCoaches()),
  )

  app.post('/api/v1/roster/coaches', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const created = await addCoach({ ...body(req, newCoachBody), actor: principalOf(req).email })
    reply.status(201)
    return ok(created)
  })

  app.patch('/api/v1/roster/coaches/:id', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await reviseCoach({
      coachId: params(req, idParams).id, ...body(req, coachBody), actor: principalOf(req).email,
    })),
  )

  // ── Assignment (E28) ────────────────────────────────────────────────────────────────────

  /**
   * Everything the assignment surface needs, in one read.
   *
   * Organiser-only, because it carries every participant's name and address.
   */
  app.get('/api/v1/roster/board', { preHandler: requireRole('organiser') }, async () =>
    ok(await rosterBoard()),
  )

  /**
   * Create a team, optionally with its first member (E28-S02 acceptance 7).
   *
   * `POST`, not `PUT`: creating the same team twice is not the same outcome as creating it once,
   * and the second attempt is refused by name.
   */
  app.post('/api/v1/roster/teams', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, teamBody)
    const created = await createTeam({ ...input, actor: principalOf(req).email })
    reply.status(201)
    return ok(created)
  })

  /**
   * Put a participant on a team, moving them if they are already on another.
   *
   * `PUT` rather than `POST`: assigning the same person to the same team twice is the same
   * outcome, and an operator clicking twice should not be told off for it.
   */
  app.put('/api/v1/roster/teams/:id/members', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, memberBody)
    return ok(await (input.move === true ? move : assign)({
      teamId: params(req, idParams).id,
      participantId: input.participantId,
      ...(input.asContact !== undefined && { asContact: input.asContact }),
      actor: principalOf(req).email,
    }))
  })

  /** Take a participant off whichever team they are on. The participant is untouched. */
  app.delete('/api/v1/roster/members/:id', { preHandler: requireRole('organiser') }, async (req, reply) => {
    await unassign({ participantId: params(req, idParams).id, actor: principalOf(req).email })
    reply.status(204)
    return null
  })

  /** Name the person the team is reached through; their address becomes the team's contact. */
  app.put('/api/v1/roster/teams/:id/contact', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await setContact({
      teamId: params(req, idParams).id,
      participantId: body(req, z.object({ participantId: z.number().int().min(1) })).participantId,
      actor: principalOf(req).email,
    })),
  )

  // ── What each team was given ────────────────────────────────────────────────────────────
  /** What is not ready about the roster (E28-S04). Advisory throughout; nothing is refused. */
  app.get('/api/v1/roster/readiness', { preHandler: requireRole('viewer') }, async () =>
    ok(await rosterReadiness()),
  )

  app.get('/api/v1/roster/logistics', { preHandler: requireRole('viewer') }, async () =>
    ok(await getLogistics()),
  )

  app.put('/api/v1/roster/teams/:id/logistics', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await assignLogistics({
      teamId: params(req, idParams).id, ...body(req, logisticsBody),
      actor: principalOf(req).email,
    })),
  )
}
