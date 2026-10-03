/**
 * What is not ready about the roster (E28-S04).
 *
 * Three checks, and the reason each one NAMES what is wrong rather than counting it: "7
 * unassigned" is a complaint, and the seven names are a worklist. An organiser reading this on
 * the morning of the event needs the second.
 *
 * Every one of these is **advisory**. A half-formed team at 9am is normal, and a system that
 * refused to record it would be describing a world that does not exist. What this refuses to do
 * is let the state go unnoticed.
 */
import { query } from '../../../db/pool.js'
import { teamSizeBounds } from './teamSizeRule.js'

export type RosterStatus = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface RosterCheck {
  id: string
  statement: string
  status: RosterStatus
  detail: string
}

/** How many names to print before summarising. Long enough to act on, short enough to read. */
const NAMED = 8

const named = (names: readonly string[]): string =>
  names.length <= NAMED
    ? names.join(', ')
    : `${names.slice(0, NAMED).join(', ')} and ${names.length - NAMED} more`

export async function rosterReadiness(): Promise<RosterCheck[]> {
  return [
    await everybodyAssigned(),
    await teamsWithinSize(),
    await teamsHavePlaceAndCoach(),
    await teamsCanBeContacted(),
    await noCoachAlsoJudges(),
  ]
}

/**
 * A coach who is also a reviewer or judge (E29-S03).
 *
 * The conflict a roster makes visible and nothing else can: a coach helps produce the work, so
 * one who also decides about it is judging their own. Coaches are not Crucible users and
 * participants are not either, so before the roster existed nothing in this system connected the
 * two — which means nothing detected it.
 *
 * A **warning naming the person**, never a refusal. At a small event the same person may
 * legitimately hold both roles, and the thing that matters is that somebody knew rather than that
 * the system had an opinion. Read through `v_governance_actor`, the published view, rather than by
 * joining `crucible_user` (P1.3).
 */
async function noCoachAlsoJudges(): Promise<RosterCheck> {
  const statement = 'No coach also holds a role that decides about the work they coached.'

  const rows = await query<{ full_name: string; role: string; teams: string[] }>(
    `SELECT c.full_name,
            a.role,
            COALESCE(array_agg(t.display_name ORDER BY t.display_name)
                       FILTER (WHERE t.display_name IS NOT NULL), '{}') AS teams
       FROM coach c
       JOIN v_governance_actor a ON lower(btrim(a.email)) = lower(btrim(c.email))
       LEFT JOIN team_logistics l ON l.coach_id = c.coach_id
       LEFT JOIN v_team t ON t.team_id = l.team_id
      WHERE a.role IN ('reviewer', 'organiser', 'admin') AND a.active
      GROUP BY c.full_name, a.role
      ORDER BY c.full_name`)

  const coaches = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM coach')
  if ((coaches.rows[0]?.n ?? 0) === 0) {
    return check('roster_coach_conflict', statement, 'UNKNOWN',
      'No coaches have been loaded, so whether any of them also judges cannot be answered.')
  }

  if (rows.rows.length === 0) {
    return check('roster_coach_conflict', statement, 'PASS',
      'No coach holds a reviewing role.')
  }

  const described = rows.rows.map((r) => {
    const teams = r.teams.length === 0 ? 'no team yet' : r.teams.join(', ')
    return `${r.full_name} (${r.role}; coaches ${teams})`
  })
  return check('roster_coach_conflict', statement, 'FAIL',
    `${described.join('; ')}. This is permitted and is not blocked — but a person deciding about `
    + `work they helped produce should be a choice somebody made knowingly.`)
}

async function everybodyAssigned(): Promise<RosterCheck> {
  const statement = 'Every participant is on a team.'

  const rows = await query<{ full_name: string }>(
    `SELECT p.full_name FROM participant p
       LEFT JOIN team_member m ON m.participant_id = p.participant_id
      WHERE p.deleted_at IS NULL AND m.member_id IS NULL
      ORDER BY lower(p.full_name)`)

  const total = await query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM participant WHERE deleted_at IS NULL')

  // UNKNOWN, not PASS. A list that was never loaded is not a list with nobody unassigned, and
  // treating the two alike is how a checklist becomes decoration.
  if ((total.rows[0]?.n ?? 0) === 0) {
    return check('roster_assigned', statement, 'UNKNOWN',
      'No participants have been loaded, so whether everybody is on a team cannot be answered '
      + 'either way.')
  }

  return rows.rows.length === 0
    ? check('roster_assigned', statement, 'PASS',
      `All ${total.rows[0]!.n} participants are on a team.`)
    : check('roster_assigned', statement, 'FAIL',
      `${rows.rows.length} of ${total.rows[0]!.n} not on a team: `
      + `${named(rows.rows.map((r) => r.full_name))}.`)
}

async function teamsWithinSize(): Promise<RosterCheck> {
  const statement = 'Every team has between the minimum and maximum members.'

  // The same numbers the public endpoint refuses on (E42-S01). Read through the one declaration,
  // so the checklist cannot pass a team that registration would have rejected.
  const { min, max } = await teamSizeBounds()

  const rows = await query<{ team_id: number; display_name: string; members: number }>(
    `SELECT t.team_id, t.display_name, COALESCE(s.members, 0) AS members
       FROM v_team t
       LEFT JOIN v_roster_team_size s ON s.team_id = t.team_id
      ORDER BY t.display_name`)

  if (rows.rows.length === 0) {
    return check('roster_team_size', statement, 'UNKNOWN',
      'No teams exist yet, so their sizes cannot be checked.')
  }

  const wrong = rows.rows.filter((r) => Number(r.members) < min || Number(r.members) > max)
  return wrong.length === 0
    ? check('roster_team_size', statement, 'PASS',
      `All ${rows.rows.length} teams have between ${min} and ${max} members.`)
    : check('roster_team_size', statement, 'FAIL',
      `${wrong.length} outside ${min}–${max}: `
      + `${named(wrong.map((r) => `${r.display_name} (${r.members})`))}.`)
}

/**
 * A team nobody can be written to (E28-S02).
 *
 * The address is how a team gets its submission token, so a team without one cannot take part —
 * and nothing else in the system notices. Two ways a team ends up here: created from the
 * assignment surface before anybody was on it, or imported from a row whose email column was
 * blank. Both record an empty string, and an empty string in a column nobody reads is the defect
 * this codebase keeps finding.
 *
 * Empty and NULL are both "no address". Treating them differently would make the check depend on
 * which path created the team, which is not a distinction an organiser can act on.
 */
async function teamsCanBeContacted(): Promise<RosterCheck> {
  const statement = 'Every team has an address its token can be sent to.'

  const rows = await query<{ display_name: string; members: number }>(
    `SELECT t.display_name, COALESCE(s.members, 0) AS members
       FROM v_team t
       LEFT JOIN v_roster_team_size s ON s.team_id = t.team_id
      WHERE COALESCE(btrim(s.contact_email), btrim(t.contact_email), '') = ''
      ORDER BY t.display_name`)

  const total = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM v_team')
  if ((total.rows[0]?.n ?? 0) === 0) {
    return check('roster_team_contact', statement, 'UNKNOWN',
      'No teams exist yet, so whether they can be contacted cannot be answered.')
  }

  if (rows.rows.length === 0) {
    return check('roster_team_contact', statement, 'PASS',
      `All ${total.rows[0]!.n} teams have a contact address.`)
  }

  // Naming whether the team is empty, because the fix differs: put somebody on it, or fill in the
  // address of somebody already there.
  const described = rows.rows.map((r) =>
    Number(r.members) === 0 ? `${r.display_name} (nobody on it)` : r.display_name)
  return check('roster_team_contact', statement, 'FAIL',
    `${rows.rows.length} of ${total.rows[0]!.n} have no address: ${named(described)}. `
    + `Naming a point of contact on the team sets it.`)
}

async function teamsHavePlaceAndCoach(): Promise<RosterCheck> {
  const statement = 'Every team has a room and a coach.'

  const rows = await query<{ display_name: string; room_id: number | null; coach_id: number | null }>(
    `SELECT t.display_name, l.room_id, l.coach_id
       FROM v_team t
       LEFT JOIN v_roster_team_logistics l ON l.team_id = t.team_id
      ORDER BY t.display_name`)

  if (rows.rows.length === 0) {
    return check('roster_logistics', statement, 'UNKNOWN',
      'No teams exist yet, so their rooms and coaches cannot be checked.')
  }

  const noRoom = rows.rows.filter((r) => r.room_id === null).map((r) => r.display_name)
  const noCoach = rows.rows.filter((r) => r.coach_id === null).map((r) => r.display_name)

  if (noRoom.length === 0 && noCoach.length === 0) {
    return check('roster_logistics', statement, 'PASS',
      `All ${rows.rows.length} teams have a room and a coach.`)
  }

  const parts: string[] = []
  if (noRoom.length > 0) parts.push(`no room: ${named(noRoom)}`)
  if (noCoach.length > 0) parts.push(`no coach: ${named(noCoach)}`)
  return check('roster_logistics', statement, 'FAIL', `${parts.join('; ')}.`)
}

const check = (
  id: string, statement: string, status: RosterStatus, detail: string,
): RosterCheck => ({ id, statement, status, detail })
