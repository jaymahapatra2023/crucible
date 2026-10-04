/**
 * All SQL for coach arrival (P1.2, migration 105).
 */
import { query, queryOne } from '../../../db/pool.js'

export interface CoachArrival {
  coachId: number
  fullName: string
  email: string
  organisation: string | null
  teamCapacity: number | null
  arrivedAt: Date | null
  arrived: boolean
  teamsAssigned: number
  /** Teams with nobody, because this coach has not confirmed. Zero once they have. */
  teamsUncovered: number
}

interface Row {
  coach_id: number; full_name: string; email: string; organisation: string | null
  team_capacity: number | null; arrived_at: Date | null; arrived: boolean
  teams_assigned: number; teams_uncovered: number
}

const toArrival = (r: Row): CoachArrival => ({
  coachId: Number(r.coach_id), fullName: r.full_name, email: r.email,
  organisation: r.organisation,
  teamCapacity: r.team_capacity === null ? null : Number(r.team_capacity),
  arrivedAt: r.arrived_at, arrived: r.arrived,
  teamsAssigned: Number(r.teams_assigned), teamsUncovered: Number(r.teams_uncovered),
})

export async function listArrivals(): Promise<CoachArrival[]> {
  const res = await query<Row>(
    'SELECT * FROM v_roster_coach_arrival ORDER BY arrived, lower(full_name)')
  return res.rows.map(toArrival)
}

/**
 * The names the public page offers, and nothing else.
 *
 * Names only: no address, no organisation, no team count. A coach's name is already on the door
 * of the room they are coaching in, so listing it costs nothing; their email is not, and the
 * page has no reason to show it.
 */
export async function listCoachNames(): Promise<string[]> {
  const res = await query<{ full_name: string }>(
    'SELECT full_name FROM coach WHERE active ORDER BY lower(full_name)')
  return res.rows.map((r) => r.full_name)
}

/**
 * Stamp an arrival by name.
 *
 * Name alone, because the page offers the list and the whole point is one tap on a phone while
 * walking into a building. The trade is real and small: anybody could mark a coach present. What
 * that buys them is nothing — it redirects no email, reveals no address and changes no team — and
 * the cost of being wrong is one organiser looking into a room. `arrived_at` makes a mass
 * confirmation obvious anyway, because thirty-four stamps one second apart is not thirty-four
 * people walking through a door.
 *
 * Idempotent on purpose. `COALESCE` keeps the FIRST timestamp, because when somebody arrived is
 * the useful fact and a second tap is the same person, not a later arrival.
 */
export async function markArrived(input: {
  fullName: string
}): Promise<{ coachId: number } | null> {
  const row = await queryOne<{ coach_id: number }>(
    `UPDATE coach
        SET arrived_at = COALESCE(arrived_at, now()), updated_at = now()
      WHERE active AND person_normalise(full_name) = person_normalise($1)
      RETURNING coach_id`,
    [input.fullName])
  return row ? { coachId: Number(row.coach_id) } : null
}
