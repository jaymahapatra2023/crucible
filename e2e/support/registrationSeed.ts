/**
 * A roster and a live registration link, for the public registration journey (E44).
 *
 * The link is seeded directly with a known token: with the recording mail provider nothing is
 * transmitted, so the only way a browser test can hold a link is to plant one. Its hash is
 * computed here exactly as the service computes it, so the seed and the code cannot disagree
 * about what a link is.
 */
import { createHash } from 'node:crypto'
import { pool } from './seed.js'

export const E2E_LINK = 'crr_e2e-registration-link-0000000000'

export async function seedRegistration(): Promise<void> {
  const db = pool()
  try {
    await db.query(`TRUNCATE TABLE registration_link, team_member, team_logistics, participant,
                                   submission, team, access_token, token_delivery,
                                   submission_window, rubric_criterion, rubric,
                                   challenge_artifact, challenge
                    RESTART IDENTITY CASCADE`)
    await db.query(
      `UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.http.rate_limit'`)

    await db.query(
      `INSERT INTO challenge (name, slug, status, created_by)
       VALUES ('RealWorld Conduit', 'realworld-conduit', 'OPEN', 'e2e')`)

    await db.query(
      `INSERT INTO participant (full_name, email, created_by) VALUES
         ('Ada Lovelace', 'ada@example.test', 'e2e'),
         ('Grace Hopper', 'grace@example.test', 'e2e'),
         ('Alan Turing', 'alan@example.test', 'e2e'),
         ('Katherine Johnson', 'katherine@example.test', 'e2e')`)

    const hash = createHash('sha256').update(E2E_LINK).digest('hex')
    await db.query(
      `INSERT INTO registration_link (participant_id, token_hash, expires_at)
       SELECT participant_id, $1, now() + interval '1 hour'
         FROM participant WHERE email = 'ada@example.test'`, [hash])
  } finally {
    await db.end()
  }
}
