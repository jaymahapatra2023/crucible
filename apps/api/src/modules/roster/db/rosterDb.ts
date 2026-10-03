/**
 * All SQL for the roster (P1.2).
 *
 * `team_logistics.team_id` is a plain column rather than a foreign key: `team` belongs to the
 * submissions module, and per ADR 0002 a cross-module reference is resolved at the service layer
 * rather than by the storage engine. `room_id` and `coach_id` are real foreign keys because they
 * are within this module.
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import {
  participantOrder, participantWhere, type ParticipantFilter,
} from './participantQuery.js'
import type {
  Coach, DeleteReason, Participant, TeamLogistics,
} from '../types/rosterTypes.js'

// ── Participants ──────────────────────────────────────────────────────────────────────────

interface ParticipantRow {
  participant_id: number; full_name: string; email: string
  organisation: string | null; phone: string | null; notes: string
  discord_username: string | null; discord_user_id: string | null
}

const toParticipant = (r: ParticipantRow): Participant => ({
  participantId: Number(r.participant_id), fullName: r.full_name, email: r.email,
  organisation: r.organisation, phone: r.phone, notes: r.notes,
  discordUsername: r.discord_username, discordUserId: r.discord_user_id,
})

const P_COLS = 'participant_id, full_name, email, organisation, phone, notes, discord_username, discord_user_id'

export async function insertParticipant(input: {
  fullName: string; email: string; organisation: string | null; phone: string | null
  notes: string; createdBy: string
  discordUsername?: string | null; discordUserId?: string | null
}, client?: DbClient): Promise<Participant> {
  const row = await queryOne<ParticipantRow>(
    `INSERT INTO participant (full_name, email, organisation, phone, notes, created_by, discord_username, discord_user_id)
     VALUES ($1,$2,$3,$4,$5,$6, $7, $8) RETURNING ${P_COLS}`,
    [input.fullName, input.email, input.organisation, input.phone, input.notes, input.createdBy,
     input.discordUsername ?? null, input.discordUserId ?? null],
    client)
  if (!row) throw new Error('insertParticipant returned no row')
  return toParticipant(row)
}

/** Living participants only. An erased one is gone from every read (P7.4). */
export async function listParticipants(
  limit = 1000, offset = 0, sort?: string, filter: ParticipantFilter = {},
): Promise<Participant[]> {
  const { sql, params } = participantWhere(filter, 3)
  const order = participantOrder(sort)
  const res = await query<ParticipantRow>(
    `SELECT ${P_COLS} FROM participant ${sql}
      ORDER BY ${order}, participant_id ASC LIMIT $1 OFFSET $2`,
    [limit, offset, ...params])
  return res.rows.map(toParticipant)
}

export async function countParticipants(filter: ParticipantFilter = {}): Promise<number> {
  const { sql, params } = participantWhere(filter, 1)
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM participant ${sql}`, params)
  return row?.n ?? 0
}

export async function selectParticipant(participantId: number): Promise<Participant | null> {
  const row = await queryOne<ParticipantRow>(
    `SELECT ${P_COLS} FROM participant
      WHERE participant_id = $1 AND deleted_at IS NULL`, [participantId])
  return row ? toParticipant(row) : null
}

/** By address, case- and space-insensitively — the key the import matches on. */
export async function selectParticipantByEmail(email: string): Promise<Participant | null> {
  const row = await queryOne<ParticipantRow>(
    `SELECT ${P_COLS} FROM participant
      WHERE lower(btrim(email)) = lower(btrim($1)) AND deleted_at IS NULL`, [email])
  return row ? toParticipant(row) : null
}

/**
 * Correct a participant.
 *
 * A field ABSENT means leave it alone; a field given as `null` means clear it. `COALESCE` reads
 * both as "leave it", so each nullable column carries its own "was it supplied" flag. Without
 * this a screen that sends the whole object on save can set an organisation and never remove one.
 */
export async function updateParticipant(input: {
  participantId: number; fullName?: string; email?: string
  organisation?: string | null; phone?: string | null; notes?: string
  discordUsername?: string | null; discordUserId?: string | null
}): Promise<Participant | null> {
  const row = await queryOne<ParticipantRow>(
    `UPDATE participant
        SET full_name    = COALESCE($2, full_name),
            email        = COALESCE($3, email),
            notes        = COALESCE($4, notes),
            organisation = CASE WHEN $6 THEN $5 ELSE organisation END,
            phone        = CASE WHEN $8 THEN $7 ELSE phone END,
            discord_username = CASE WHEN $10 THEN $9 ELSE discord_username END,
            discord_user_id  = CASE WHEN $12 THEN $11 ELSE discord_user_id END,
            updated_at   = now()
      WHERE participant_id = $1 AND deleted_at IS NULL RETURNING ${P_COLS}`,
    [input.participantId, input.fullName ?? null, input.email ?? null, input.notes ?? null,
     input.organisation ?? null, input.organisation !== undefined,
     input.phone ?? null, input.phone !== undefined,
     input.discordUsername ?? null, input.discordUsername !== undefined,
     input.discordUserId ?? null, input.discordUserId !== undefined])
  return row ? toParticipant(row) : null
}

/** Soft delete with a reason (P7.4). Nothing here hard-deletes a person. */
export async function softDeleteParticipant(
  participantId: number, reason: DeleteReason, actor: string,
): Promise<boolean> {
  const res = await query(
    `UPDATE participant SET deleted_at = now(), deleted_by = $3, delete_reason = $2
      WHERE participant_id = $1 AND deleted_at IS NULL`,
    [participantId, reason, actor])
  return (res.rowCount ?? 0) > 0
}

// ── Coaches ───────────────────────────────────────────────────────────────────────────────

interface CoachRow {
  coach_id: number; full_name: string; email: string
  organisation: string | null; team_capacity: number | null; active: boolean
}

const toCoach = (r: CoachRow): Coach => ({
  coachId: Number(r.coach_id), fullName: r.full_name, email: r.email,
  organisation: r.organisation,
  teamCapacity: r.team_capacity === null ? null : Number(r.team_capacity),
  active: r.active,
})

const C_COLS = 'coach_id, full_name, email, organisation, team_capacity, active'

export async function insertCoach(input: {
  fullName: string; email: string; organisation: string | null
  teamCapacity?: number | null; createdBy: string
}, client?: DbClient): Promise<Coach> {
  const row = await queryOne<CoachRow>(
    `INSERT INTO coach (full_name, email, organisation, team_capacity, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${C_COLS}`,
    [input.fullName, input.email, input.organisation, input.teamCapacity ?? null,
     input.createdBy], client)
  if (!row) throw new Error('insertCoach returned no row')
  return toCoach(row)
}

export async function listCoaches(): Promise<Coach[]> {
  const res = await query<CoachRow>(`SELECT ${C_COLS} FROM coach ORDER BY lower(full_name)`)
  return res.rows.map(toCoach)
}

export async function selectCoachByEmail(email: string): Promise<Coach | null> {
  const row = await queryOne<CoachRow>(
    `SELECT ${C_COLS} FROM coach WHERE lower(btrim(email)) = lower(btrim($1))`, [email])
  return row ? toCoach(row) : null
}

export async function updateCoach(input: {
  coachId: number; fullName?: string; email?: string
  organisation?: string | null; teamCapacity?: number | null; active?: boolean
}): Promise<Coach | null> {
  const row = await queryOne<CoachRow>(
    `UPDATE coach SET full_name = COALESCE($2, full_name), email = COALESCE($3, email),
                      active = COALESCE($4, active),
                      organisation = CASE WHEN $6 THEN $5 ELSE organisation END,
                      team_capacity = CASE WHEN $8 THEN $7 ELSE team_capacity END,
                      updated_at = now()
      WHERE coach_id = $1 RETURNING ${C_COLS}`,
    [input.coachId, input.fullName ?? null, input.email ?? null, input.active ?? null,
     input.organisation ?? null, input.organisation !== undefined,
     input.teamCapacity ?? null, input.teamCapacity !== undefined])
  return row ? toCoach(row) : null
}

// ── What each team was given ───────────────────────────────────────────────────────────────

interface LogisticsRow {
  team_id: number; room_id: number | null; room_label: string | null
  room_location: string | null; coach_id: number | null
  coach_name: string | null; coach_email: string | null
}

const toLogistics = (r: LogisticsRow): TeamLogistics => ({
  teamId: Number(r.team_id),
  roomId: r.room_id === null ? null : Number(r.room_id),
  roomLabel: r.room_label, roomLocation: r.room_location,
  coachId: r.coach_id === null ? null : Number(r.coach_id),
  coachName: r.coach_name, coachEmail: r.coach_email,
})

export async function selectLogistics(teamIds?: readonly number[]): Promise<TeamLogistics[]> {
  const res = await query<LogisticsRow>(
    `SELECT * FROM v_roster_team_logistics
      WHERE ($1::bigint[] IS NULL OR team_id = ANY($1)) ORDER BY team_id`,
    [teamIds && teamIds.length > 0 ? teamIds : null])
  return res.rows.map(toLogistics)
}

/**
 * Give a team a room, a coach, or both.
 *
 * Upserted, because logistics are a property of the team rather than an event in its history —
 * a team has one room at a time and the audit trail records the moves.
 */
export async function upsertLogistics(input: {
  teamId: number; roomId?: number | null; coachId?: number | null; actor: string
}): Promise<void> {
  await query(
    `INSERT INTO team_logistics (team_id, room_id, coach_id, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (team_id) DO UPDATE SET
       room_id    = CASE WHEN $5 THEN EXCLUDED.room_id  ELSE team_logistics.room_id  END,
       coach_id   = CASE WHEN $6 THEN EXCLUDED.coach_id ELSE team_logistics.coach_id END,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [input.teamId, input.roomId ?? null, input.coachId ?? null, input.actor,
     input.roomId !== undefined, input.coachId !== undefined])
}

// ── Membership ─────────────────────────────────────────────────────────────────────────────

export interface TeamMember {
  memberId: number
  teamId: number
  participantId: number
  fullName: string
  email: string
  organisation: string | null
  isContact: boolean
  /** So making them the contact carries it to the team, as the address is carried (E49). */
  discordUserId: string | null
}

interface MemberRow {
  member_id: number; team_id: number; participant_id: number
  full_name: string; email: string; organisation: string | null; is_contact: boolean
  discord_user_id: string | null
}

const toMember = (r: MemberRow): TeamMember => ({
  memberId: Number(r.member_id), teamId: Number(r.team_id),
  participantId: Number(r.participant_id), fullName: r.full_name, email: r.email,
  organisation: r.organisation, isContact: r.is_contact, discordUserId: r.discord_user_id,
})

const M_COLS = 'member_id, team_id, participant_id, full_name, email, organisation, is_contact, discord_user_id'

export async function insertMember(input: {
  teamId: number; participantId: number; isContact: boolean; actor: string
}, client?: DbClient): Promise<void> {
  await query(
    `INSERT INTO team_member (team_id, participant_id, is_contact, assigned_by)
     VALUES ($1,$2,$3,$4)`,
    [input.teamId, input.participantId, input.isContact, input.actor], client)
}

export async function deleteMember(participantId: number): Promise<boolean> {
  const res = await query(
    'DELETE FROM team_member WHERE participant_id = $1', [participantId])
  return (res.rowCount ?? 0) > 0
}

/** The membership one participant currently has, if any. */
export async function selectMembership(participantId: number): Promise<TeamMember | null> {
  const row = await queryOne<MemberRow>(
    `SELECT ${M_COLS} FROM v_roster_team_member WHERE participant_id = $1`, [participantId])
  return row ? toMember(row) : null
}

export async function listMembers(teamIds?: readonly number[]): Promise<TeamMember[]> {
  const res = await query<MemberRow>(
    `SELECT ${M_COLS} FROM v_roster_team_member
      WHERE ($1::bigint[] IS NULL OR team_id = ANY($1))
      ORDER BY team_id, is_contact DESC, lower(full_name)`,
    [teamIds && teamIds.length > 0 ? teamIds : null])
  return res.rows.map(toMember)
}

/**
 * Participants on no team, which is the list the assignment surface works through.
 *
 * Bounded, and the caller is given the real total separately (P5.7): "37 unassigned" has to be
 * the number unassigned, not the number this page happened to carry.
 */
export async function listUnassigned(limit = 500): Promise<Participant[]> {
  const res = await query<ParticipantRow>(
    `SELECT ${P_COLS.split(', ').map((c) => `p.${c}`).join(', ')}
       FROM participant p
       LEFT JOIN team_member m ON m.participant_id = p.participant_id
      WHERE p.deleted_at IS NULL AND m.member_id IS NULL
      ORDER BY lower(p.full_name) LIMIT $1`, [limit])
  return res.rows.map(toParticipant)
}

export async function countUnassigned(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM participant p
       LEFT JOIN team_member m ON m.participant_id = p.participant_id
      WHERE p.deleted_at IS NULL AND m.member_id IS NULL`)
  return row?.n ?? 0
}

/** Clear whichever member currently holds the contact flag, so the next one can take it. */
export async function clearContact(teamId: number, client?: DbClient): Promise<void> {
  await query(
    'UPDATE team_member SET is_contact = FALSE WHERE team_id = $1 AND is_contact', [teamId],
    client)
}

export async function setContactFlag(
  teamId: number, participantId: number, client?: DbClient,
): Promise<boolean> {
  const res = await query(
    `UPDATE team_member SET is_contact = TRUE
      WHERE team_id = $1 AND participant_id = $2`, [teamId, participantId], client)
  return (res.rowCount ?? 0) > 0
}

export interface TeamSize { teamId: number; members: number; contactEmail: string | null }

export async function listTeamSizes(): Promise<TeamSize[]> {
  const res = await query<{ team_id: number; members: number; contact_email: string | null }>(
    'SELECT team_id, members, contact_email FROM v_roster_team_size ORDER BY team_id')
  return res.rows.map((r) => ({
    teamId: Number(r.team_id), members: Number(r.members), contactEmail: r.contact_email,
  }))
}
