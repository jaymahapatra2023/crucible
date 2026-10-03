/**
 * The state the event is in on the morning of the day (E44, E45, E50): an open challenge with a
 * published rubric, an open window, four people on the roster, and one live registration link.
 * Everything after that — the team, its code, its entry, its checks, the lock, the run — the
 * lifecycle journey does through the screens.
 */
import { createHash } from 'node:crypto'
import { clearRuns, pool } from './seed.js'
import { publishRubric } from './intakeSeed.js'

export const LIFECYCLE_LINK = 'crr_e2e-lifecycle-link-000000000000'
export const LIFECYCLE_CHALLENGE = 'RealWorld Conduit'

export async function seedLifecycle(): Promise<{ challengeId: number }> {
  await clearRuns()
  const db = pool()
  try {
    await db.query(
      `TRUNCATE TABLE cohort_final_snapshot, cohort_final_ranking, coach_dispatch,
                      gate_decision, calibration_report, gate_criteria, golden_set,
                      score_variance, criterion_score, originality_assessment, principle_assessment,
                      standard_assessment, score_run, scan, build_probe, preflight_notice, preflight_run,
                      team_reminder, registration_link, team_member, team_logistics, participant, room, coach,
                      submission, team, access_token, token_delivery, submission_window,
                      rubric_criterion, rubric, challenge_artifact, challenge
       RESTART IDENTITY CASCADE`)
    for (const [key, on] of [
      ['feature.http.rate_limit', false], ['feature.submissions.self_service', true],
      ['feature.submissions.token_reveal', true], ['feature.notify.discord', false],
      ['feature.calibration.bypass_gate', true],
    ] as const) {
      await db.query(
        `UPDATE feature_flag SET enabled = $2, updated_by = 'e2e', updated_at = now() WHERE key = $1`, [key, on])
    }

    const challenge = await db.query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, description, status, created_by)
       VALUES ($1, 'e2e-lifecycle', 'Implement the Conduit API and client.', 'OPEN', 'e2e') RETURNING challenge_id`,
      [LIFECYCLE_CHALLENGE])
    const challengeId = challenge.rows[0]!.challenge_id
    await publishRubric(db, challengeId)

    await db.query(
      `INSERT INTO submission_window (name, opens_at, closes_at)
       VALUES ('Lifecycle window', now() - interval '1 hour', now() + interval '1 day')`)

    await db.query(
      `INSERT INTO participant (full_name, email, created_by) VALUES
         ('Ada Lovelace', 'ada@example.test', 'e2e'), ('Grace Hopper', 'grace@example.test', 'e2e'),
         ('Alan Turing', 'alan@example.test', 'e2e'), ('Katherine Johnson', 'katherine@example.test', 'e2e')`)
    await db.query(
      `INSERT INTO registration_link (participant_id, token_hash, expires_at)
       SELECT participant_id, $1, now() + interval '1 hour' FROM participant WHERE email = 'ada@example.test'`,
      [createHash('sha256').update(LIFECYCLE_LINK).digest('hex')])
    return { challengeId }
  } finally {
    await db.end()
  }
}

export async function countSubmissionsFor(teamName: string): Promise<number> {
  const db = pool()
  try {
    const res = await db.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM submission WHERE team_name = $1', [teamName])
    return Number(res.rows[0]!.n)
  } finally {
    await db.end()
  }
}
