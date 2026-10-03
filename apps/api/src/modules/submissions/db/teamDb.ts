/**
 * All SQL for teams (P1.2, E17-S01).
 *
 * A team is a record with a stable id. It is deliberately NOT an account: teams have no password
 * and nothing to sign in to (P8.2). The id exists so that a rename is a rename rather than the
 * birth of a second team, and so that a token can name who it belongs to.
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'

/** REGISTRATION: the participants formed it themselves through the public link (E44). */
export type TeamOrigin = 'TOKEN' | 'ORGANISER' | 'BACKFILL' | 'REGISTRATION'

export interface Team {
  teamId: number
  displayName: string
  /** Lower-cased, punctuation-stripped, leading "the" removed. Derived in the database. */
  normalisedName: string
  contactEmail: string
  /** The contact's Discord user id, when the team gave one (E49). DMs go here first. */
  contactDiscordUserId: string | null
  origin: TeamOrigin
  createdAt: Date
}

interface Row {
  team_id: number; display_name: string; normalised_name: string
  contact_email: string; contact_discord_user_id: string | null; origin: TeamOrigin; created_at: Date
}

const toTeam = (r: Row): Team => ({
  teamId: Number(r.team_id), displayName: r.display_name, normalisedName: r.normalised_name,
  contactEmail: r.contact_email, contactDiscordUserId: r.contact_discord_user_id,
  origin: r.origin, createdAt: r.created_at,
})

const COLS = 'team_id, display_name, normalised_name, contact_email, contact_discord_user_id, origin, created_at'

export async function insertTeam(input: {
  displayName: string; contactEmail: string; origin: TeamOrigin; createdBy: string
  contactDiscordUserId?: string | null
  /** Set when this row is a pre-provisioned slot waiting to be claimed (migration 095). */
  slotLabel?: string | null
}, client?: DbClient): Promise<Team> {
  const row = await queryOne<Row>(
    `INSERT INTO team (display_name, contact_email, origin, created_by, contact_discord_user_id,
                       slot_label)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [input.displayName, input.contactEmail, input.origin, input.createdBy,
     input.contactDiscordUserId ?? null, input.slotLabel ?? null], client)
  if (!row) throw new Error('insertTeam returned no row')
  return toTeam(row)
}

export async function selectTeam(teamId: number, client?: DbClient): Promise<Team | null> {
  const row = await queryOne<Row>(
    `SELECT ${COLS} FROM team WHERE team_id = $1`, [teamId], client)
  return row ? toTeam(row) : null
}

/**
 * Teams whose names differ only in punctuation, case or a leading "the".
 *
 * The comparison uses `team_normalise`, the same function the stored column is generated from,
 * so there is no second definition of "the same name" to drift.
 *
 * Advisory, never enforced. "Night Shift" and "The Night Shift" may genuinely be two teams, and
 * a migration or a form that merged them would be inventing a fact. What this fixes is that
 * until now *neither the organiser nor either team knew the other existed*.
 */
export async function selectSimilarTeams(displayName: string): Promise<Team[]> {
  const res = await query<Row>(
    `SELECT ${COLS} FROM team
      WHERE normalised_name = team_normalise($1)
        -- An unclaimed slot is not a team anybody has: it is a label on a door waiting for one,
        -- and a team naming itself "Team 7" must not collide with the sign (migration 095).
        AND NOT (slot_label IS NOT NULL AND claimed_at IS NULL)
      ORDER BY team_id`,
    [displayName])
  return res.rows.map(toTeam)
}

export interface TeamListing extends Team {
  /** Tokens that would work right now. A team with none cannot submit. */
  activeTokens: number
  currentSubmissions: number
}

export async function listTeams(): Promise<TeamListing[]> {
  const res = await query<Row & { active_tokens: number; current_submissions: number }>(
    `SELECT ${COLS.split(', ').map((c) => `t.${c}`).join(', ')},
            (SELECT COUNT(*)::int FROM access_token a
              WHERE a.team_id = t.team_id AND a.kind = 'SUBMISSION'
                AND a.revoked_at IS NULL
                AND (a.expires_at IS NULL OR a.expires_at > now()))      AS active_tokens,
            (SELECT COUNT(*)::int FROM submission s
              WHERE s.team_id = t.team_id AND s.is_current)              AS current_submissions
       FROM team t ORDER BY t.display_name`)
  return res.rows.map((r) => ({
    ...toTeam(r),
    activeTokens: Number(r.active_tokens),
    currentSubmissions: Number(r.current_submissions),
  }))
}

/**
 * Rename a team, or correct its contact.
 *
 * `display_name` is editable precisely because identity is the id: the name changing is a
 * rename, not a new team, and the version chain holds across it (E17-S01 acceptance 4).
 */
export async function updateTeam(input: {
  teamId: number; displayName?: string; contactEmail?: string
  /** Absent: leave it. Null: clear it (a contact with no Discord). */
  contactDiscordUserId?: string | null
}, client?: DbClient): Promise<Team | null> {
  const row = await queryOne<Row>(
    `UPDATE team
        SET display_name  = COALESCE($2, display_name),
            contact_email = COALESCE($3, contact_email),
            contact_discord_user_id = CASE WHEN $5 THEN $4 ELSE contact_discord_user_id END,
            updated_at    = now()
      WHERE team_id = $1 RETURNING ${COLS}`,
    [input.teamId, input.displayName ?? null, input.contactEmail ?? null,
     input.contactDiscordUserId ?? null, input.contactDiscordUserId !== undefined], client)
  return row ? toTeam(row) : null
}
