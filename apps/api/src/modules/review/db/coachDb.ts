/**
 * What a coach sheet reads that the review module does not otherwise hold (P1.2, P1.3): the
 * names behind criterion ids, who is on a team, who coaches it, and the record of sheets sent.
 * Every cross-module read is through a published view.
 */
import { query } from '../../../db/pool.js'

export async function criterionNames(ids: readonly number[]): Promise<Map<number, { name: string; dimension: string }>> {
  if (ids.length === 0) return new Map()
  const res = await query<{ criterion_id: number; name: string; dimension: string }>(
    'SELECT criterion_id, name, dimension FROM v_rubrics_criterion WHERE criterion_id = ANY($1::bigint[])', [ids])
  return new Map(res.rows.map((r) => [Number(r.criterion_id), { name: r.name, dimension: r.dimension }]))
}

export async function membersFor(teamId: number): Promise<Array<{ fullName: string; isContact: boolean }>> {
  const res = await query<{ full_name: string; is_contact: boolean }>(
    'SELECT full_name, is_contact FROM v_roster_team_member WHERE team_id = $1 ORDER BY is_contact DESC, full_name', [teamId])
  return res.rows.map((r) => ({ fullName: r.full_name, isContact: r.is_contact }))
}

export interface CoachAssignment {
  teamId: number
  coachId: number | null
  coachName: string | null
  coachEmail: string | null
  roomLabel: string | null
}

export async function coachesFor(teamIds: readonly number[]): Promise<Map<number, CoachAssignment>> {
  if (teamIds.length === 0) return new Map()
  const res = await query<{
    team_id: number; coach_id: number | null; coach_name: string | null; coach_email: string | null; room_label: string | null
  }>(
    `SELECT team_id, coach_id, coach_name, coach_email, room_label
       FROM v_roster_team_logistics WHERE team_id = ANY($1::bigint[])`, [teamIds])
  return new Map(res.rows.map((r) => [Number(r.team_id), {
    teamId: Number(r.team_id), coachId: r.coach_id === null ? null : Number(r.coach_id),
    coachName: r.coach_name, coachEmail: r.coach_email, roomLabel: r.room_label,
  }]))
}

export async function challengeName(challengeId: number): Promise<string> {
  const res = await query<{ name: string }>('SELECT name FROM v_challenges_challenge WHERE challenge_id = $1', [challengeId])
  return res.rows[0]?.name ?? `Challenge ${challengeId}`
}

export interface DispatchRow {
  dispatchId: number
  runIndexId: number
  coachId: number
  teamIds: number[]
  status: 'SENT' | 'PREPARED' | 'FAILED'
  provider: string
  detail: string | null
  providerRef: string | null
  sentBy: string
  sentAt: Date
}

export async function insertDispatch(input: Omit<DispatchRow, 'dispatchId' | 'sentAt'>): Promise<DispatchRow> {
  const res = await query<{
    dispatch_id: number; run_index_id: number; coach_id: number; team_ids: number[]; status: DispatchRow['status']
    provider: string; detail: string | null; provider_ref: string | null; sent_by: string; sent_at: Date
  }>(
    `INSERT INTO coach_dispatch (run_index_id, coach_id, team_ids, status, provider, detail, provider_ref, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.runIndexId, input.coachId, input.teamIds, input.status, input.provider, input.detail, input.providerRef, input.sentBy])
  const r = res.rows[0]!
  return {
    dispatchId: Number(r.dispatch_id), runIndexId: Number(r.run_index_id), coachId: Number(r.coach_id),
    teamIds: r.team_ids.map(Number), status: r.status, provider: r.provider, detail: r.detail,
    providerRef: r.provider_ref, sentBy: r.sent_by, sentAt: r.sent_at,
  }
}

export async function latestDispatches(runIndexId: number): Promise<Map<number, DispatchRow>> {
  const res = await query<{
    dispatch_id: number; run_index_id: number; coach_id: number; team_ids: number[]; status: DispatchRow['status']
    provider: string; detail: string | null; provider_ref: string | null; sent_by: string; sent_at: Date
  }>(
    `SELECT DISTINCT ON (coach_id) * FROM coach_dispatch WHERE run_index_id = $1 ORDER BY coach_id, sent_at DESC`,
    [runIndexId])
  return new Map(res.rows.map((r) => [Number(r.coach_id), {
    dispatchId: Number(r.dispatch_id), runIndexId: Number(r.run_index_id), coachId: Number(r.coach_id),
    teamIds: r.team_ids.map(Number), status: r.status, provider: r.provider, detail: r.detail,
    providerRef: r.provider_ref, sentBy: r.sent_by, sentAt: r.sent_at,
  }]))
}
