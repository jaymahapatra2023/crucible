/**
 * E2E fixture for the roster journeys (E27, E28).
 *
 * Written straight to the database: the journey under test is an organiser assigning people, and
 * making it depend on the import path would make an assignment test fail for a CSV reason.
 */
import pg from 'pg'

const pool = (): pg.Pool =>
  new pg.Pool({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test',
  })

export interface SeededRoster {
  teamIds: number[]
  participantIds: number[]
}

const PEOPLE = [
  ['Ada Lovelace', 'ada@example.test'],
  ['Grace Hopper', 'grace@example.test'],
  ['Alan Turing', 'alan@example.test'],
  ['Katherine Johnson', 'katherine@example.test'],
] as const

/** Four unassigned people, two teams, one room and one coach. Nothing is assigned. */
export async function seedRoster(): Promise<SeededRoster> {
  const db = pool()
  try {
    await db.query('TRUNCATE TABLE team_member, team_logistics, participant, room, coach CASCADE')
    await db.query('TRUNCATE TABLE submission, team, token_delivery CASCADE')

    const participantIds: number[] = []
    for (const [name, email] of PEOPLE) {
      const row = await db.query<{ participant_id: number }>(
        `INSERT INTO participant (full_name, email, created_by)
         VALUES ($1, $2, 'e2e') RETURNING participant_id`, [name, email])
      participantIds.push(Number(row.rows[0]!.participant_id))
    }

    const teams = await db.query<{ team_id: number }>(
      `INSERT INTO team (display_name, contact_email, origin, created_by) VALUES
         ('Night Shift', 'night@example.test', 'ORGANISER', 'e2e'),
         ('Daylight Robbery', 'day@example.test', 'ORGANISER', 'e2e')
       RETURNING team_id`)

    await db.query(
      `INSERT INTO room (label, location, capacity, created_by)
       VALUES ('Ada Room', 'First floor', 6, 'e2e')`)
    await db.query(
      `INSERT INTO coach (full_name, email, created_by)
       VALUES ('Margaret Hamilton', 'margaret@example.test', 'e2e')`)

    return {
      teamIds: teams.rows.map((r) => Number(r.team_id)),
      participantIds,
    }
  } finally {
    await db.end()
  }
}

/**
 * A provisioned floor plan: slots with rooms and coaches, waiting to be claimed (migration 095).
 *
 * Written through the product's own service rather than by hand, so the journey exercises the
 * same path an organiser uses.
 */
export async function seedSlots(
  rows: ReadonlyArray<{ label: string; room: string; coach: string }>,
): Promise<void> {
  const db = pool()
  try {
    for (const row of rows) {
      const team = await db.query<{ team_id: number }>(
        `INSERT INTO team (display_name, contact_email, origin, created_by, slot_label)
         VALUES ($1, '', 'ORGANISER', 'e2e', $1) RETURNING team_id`, [row.label])
      await db.query(
        `INSERT INTO team_logistics (team_id, room_id, coach_id, updated_by)
         SELECT $1, r.room_id, c.coach_id, 'e2e'
           FROM room r, coach c
          WHERE r.label = $2 AND c.full_name = $3`,
        [team.rows[0]!.team_id, row.room, row.coach])
    }
  } finally {
    await db.end()
  }
}
