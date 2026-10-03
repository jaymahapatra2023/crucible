/**
 * Editing the roster, and giving each team a place and a coach (E27-S01, E27-S02, E27-S03).
 *
 * Every change records an audit event. That is the whole of the history kept for rooms and
 * coaches: P7.1 reserves append-only versioning for state an appeal turns on, and where a team
 * sat does not decide a score. The audit event answers the question actually asked — who moved
 * them, and when.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { registerLogisticsPort, type TeamPlace } from '../../../lib/ports/logisticsPort.js'
import {
  insertCoach, insertParticipant, listCoaches, selectCoachByEmail, selectLogistics, selectParticipant, selectParticipantByEmail, softDeleteParticipant, updateCoach, updateParticipant, upsertLogistics,
} from '../db/rosterDb.js'
import { insertRoom, listRooms, selectRoomByLabel, updateRoom } from '../db/roomDb.js'
import type { Coach, DeleteReason, Participant, Room, TeamLogistics } from '../types/rosterTypes.js'
import { resolveDiscordUsername } from './discordIdentity.js'

const log = createLogger('roster', 'service')

/**
 * Add one record by hand (E31-S01).
 *
 * The import loads two hundred people before the day; these three add the one who registered on
 * the morning. Both paths write the same rows through the same inserts — what differs is only
 * how many arrive at once, so a record added here is indistinguishable from an imported one
 * afterwards, which is the point.
 *
 * Each refuses a duplicate BY NAMING THE EXISTING RECORD rather than reporting a constraint. The
 * operator typing a second Ada Lovelace needs to know she is already on the roster; a message
 * about a unique index tells them a fact about the database instead of about their roster.
 *
 * The match is the same one the import uses — address for people, label for rooms — so "already
 * there" means one thing whichever way the record arrived (P1.5 clause 6).
 */
export async function addParticipant(input: {
  fullName: string
  email: string
  organisation?: string | null
  phone?: string | null
  notes?: string
  discordUsername?: string | null
  actor: string
}): Promise<Participant> {
  const clash = await selectParticipantByEmail(input.email)
  if (clash) {
    throw new AppError('CONFLICT',
      `${clash.fullName} is already on the roster with that address. Edit that record rather `
      + `than adding a second one.`)
  }

  const discord = await resolveDiscordUsername(input.discordUsername)
  const created = await insertParticipant({
    fullName: input.fullName.trim(), email: input.email.trim(),
    organisation: input.organisation ?? null, phone: input.phone ?? null,
    notes: input.notes ?? '', createdBy: input.actor,
    discordUsername: discord.username, discordUserId: discord.userId,
  })

  await recordAudit({
    actor: input.actor, action: 'roster.participant_added', subjectType: 'participant',
    // The id only. A name and an address are personal data and the audit trail is read by more
    // people than the roster is (P8.3).
    subjectId: String(created.participantId), payload: { source: 'manual' },
  })
  log.info('participant added by hand', { participantId: created.participantId })
  return created
}

export async function addRoom(input: {
  label: string
  location?: string
  capacity?: number | null
  actor: string
}): Promise<Room> {
  const clash = await selectRoomByLabel(input.label)
  if (clash) {
    throw new AppError('CONFLICT',
      `A room labelled ${clash.label} already exists. Edit it, or use a label that tells the two `
      + `apart — an operator reading a room name has to be able to find the room.`)
  }

  const created = await insertRoom({
    label: input.label.trim(), location: input.location?.trim() ?? '',
    capacity: input.capacity ?? null, createdBy: input.actor,
  })

  await recordAudit({
    actor: input.actor, action: 'roster.room_added', subjectType: 'room',
    subjectId: String(created.roomId), payload: { label: created.label },
  })
  log.info('room added by hand', { roomId: created.roomId })
  return created
}

/** A coach is explicitly not a participant (E27-S02 acceptance 3): a separate record, no team. */
export async function addCoach(input: {
  fullName: string
  email: string
  organisation?: string | null
  actor: string
}): Promise<Coach> {
  const clash = await selectCoachByEmail(input.email)
  if (clash) {
    throw new AppError('CONFLICT',
      `${clash.fullName} is already a coach with that address. Edit that record rather than `
      + `adding a second one.`)
  }

  const created = await insertCoach({
    fullName: input.fullName.trim(), email: input.email.trim(),
    organisation: input.organisation ?? null, createdBy: input.actor,
  })

  await recordAudit({
    actor: input.actor, action: 'roster.coach_added', subjectType: 'coach',
    subjectId: String(created.coachId), payload: { source: 'manual' },
  })
  log.info('coach added by hand', { coachId: created.coachId })
  return created
}

export async function reviseParticipant(input: {
  participantId: number
  fullName?: string
  email?: string
  organisation?: string | null
  phone?: string | null
  notes?: string
  /** Absent: leave it. Null or blank: clear it. Otherwise resolved against the event server. */
  discordUsername?: string | null
  actor: string
}): Promise<Participant> {
  const before = await selectParticipant(input.participantId)
  if (!before) {
    throw new AppError('NOT_FOUND', `Participant ${input.participantId} was not found.`)
  }

  const discord = input.discordUsername === undefined
    ? null
    : await resolveDiscordUsername(input.discordUsername)
  const after = await updateParticipant({
    ...input,
    ...(discord && { discordUsername: discord.username, discordUserId: discord.userId }),
  })
  if (!after) throw new AppError('NOT_FOUND', `Participant ${input.participantId} disappeared.`)

  await recordAudit({
    actor: input.actor, action: 'roster.participant_changed',
    subjectType: 'participant', subjectId: String(input.participantId),
    // WHICH fields moved, not their values. A name and an address are personal data and the
    // audit trail is read by more people than the roster is (P8.3).
    payload: { changed: changedFields(before, after) },
  })
  return after
}

const changedFields = (before: Participant, after: Participant): string[] =>
  (Object.keys(after) as Array<keyof Participant>)
    .filter((key) => before[key] !== after[key] && key !== 'participantId')

/**
 * Remove a participant, keeping the record (P7.4).
 *
 * Refused while they are on a team. Removing somebody who is still a member would leave a team
 * with a hole in its roster and no statement of why, and the caller nearly always means to
 * unassign them instead.
 */
export async function removeParticipant(input: {
  participantId: number
  reason: DeleteReason
  actor: string
  /** Supplied by the caller that knows about membership; this module does not own it. */
  onTeam?: boolean
}): Promise<void> {
  if (input.onTeam === true) {
    throw new AppError('PRECONDITION_FAILED',
      'That participant is on a team. Take them off it first — removing them now would leave a '
      + 'team short with nothing recording why.')
  }

  const removed = await softDeleteParticipant(input.participantId, input.reason, input.actor)
  if (!removed) {
    throw new AppError('NOT_FOUND',
      `Participant ${input.participantId} was not found, or has already been removed.`)
  }

  await recordAudit({
    actor: input.actor, action: 'roster.participant_removed',
    subjectType: 'participant', subjectId: String(input.participantId),
    payload: { reason: input.reason },
  })
  log.info('participant removed', { participantId: input.participantId, reason: input.reason })
}

export async function reviseRoom(input: {
  roomId: number
  label?: string
  location?: string
  capacity?: number | null
  inUse?: boolean
  actor: string
}): Promise<Room> {
  const after = await updateRoom(input)
  if (!after) throw new AppError('NOT_FOUND', `Room ${input.roomId} was not found.`)

  await recordAudit({
    actor: input.actor, action: 'roster.room_changed', subjectType: 'room',
    subjectId: String(input.roomId),
    payload: { label: after.label, inUse: after.inUse },
  })
  return after
}

export async function reviseCoach(input: {
  coachId: number
  fullName?: string
  email?: string
  organisation?: string | null
  active?: boolean
  actor: string
}): Promise<Coach> {
  const after = await updateCoach(input)
  if (!after) throw new AppError('NOT_FOUND', `Coach ${input.coachId} was not found.`)

  await recordAudit({
    actor: input.actor, action: 'roster.coach_changed', subjectType: 'coach',
    subjectId: String(input.coachId),
    payload: { changed: input.fullName !== undefined || input.email !== undefined,
      active: after.active },
  })
  return after
}

/**
 * Give a team a room, a coach, or both — or take one away.
 *
 * `null` means "take it away" and `undefined` means "leave it alone", which are different
 * intentions and were worth distinguishing: a screen that sends the whole object every time
 * would otherwise clear the field the operator did not touch.
 */
export async function assignLogistics(input: {
  teamId: number
  roomId?: number | null
  coachId?: number | null
  actor: string
}): Promise<TeamLogistics> {
  if (input.roomId === undefined && input.coachId === undefined) {
    throw new AppError('VALIDATION_FAILED',
      'Nothing to assign. Name a room, a coach, or both.')
  }

  const [before] = await selectLogistics([input.teamId])

  // A room may hold several teams (migration 096), so there is no clash to translate: the
  // crowding is reported through v_roster_room_load and the organiser decides.
  await upsertLogistics(input)

  const [after] = await selectLogistics([input.teamId])
  if (!after) throw new AppError('NOT_FOUND', `Team ${input.teamId} logistics disappeared.`)

  await recordAudit({
    actor: input.actor, action: 'roster.logistics_assigned', subjectType: 'team',
    subjectId: String(input.teamId),
    payload: {
      room: { from: before?.roomLabel ?? null, to: after.roomLabel },
      coach: { from: before?.coachName ?? null, to: after.coachName },
    },
  })
  log.info('team logistics assigned', {
    teamId: input.teamId, room: after.roomLabel, coach: after.coachName,
  })
  return after
}


export const getRooms = listRooms
export const getCoaches = listCoaches
export const getLogistics = selectLogistics

/**
 * Publish where each team sits, for the modules that identify teams to an organiser (E27-S03
 * acceptance 4).
 *
 * Registered at boot beside the other ports. Roster owns these tables; submissions and review
 * read the answer rather than the rows.
 */
export function installLogisticsPort(): void {
  registerLogisticsPort({
    async forTeams(teamIds) {
      const place = new Map<number, TeamPlace>()
      if (teamIds.length === 0) return place

      for (const row of await selectLogistics(teamIds)) {
        // Absent rather than a row of nulls: "no room recorded" is not "a room called null".
        if (row.roomLabel === null && row.coachName === null) continue
        place.set(row.teamId, {
          teamId: row.teamId, roomLabel: row.roomLabel, coachName: row.coachName,
        })
      }
      return place
    },
  })
}
