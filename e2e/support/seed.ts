/**
 * E2E fixtures: create the accounts the journeys sign in as.
 *
 * Talks to the test database directly rather than through the API, because creating the first
 * admin is a bootstrap operation the API deliberately does not expose unauthenticated.
 */
import pg from 'pg'
import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  p: string, s: Buffer, k: number, o: { N: number; r: number; p: number },
) => Promise<Buffer>

export const E2E_USERS = {
  admin: { email: 'e2e-admin@test.local', password: 'e2e-password-long-enough', role: 'admin' },
  reviewer: { email: 'e2e-reviewer@test.local', password: 'e2e-password-long-enough', role: 'reviewer' },
  organiser: { email: 'e2e-organiser@test.local', password: 'e2e-password-long-enough', role: 'organiser' },
  viewer: { email: 'e2e-viewer@test.local', password: 'e2e-password-long-enough', role: 'viewer' },
} as const

export type E2ERole = keyof typeof E2E_USERS

async function hash(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`
}

export function pool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test',
  })
}

export async function seedE2EUsers(): Promise<void> {
  const db = pool()
  try {
    for (const u of Object.values(E2E_USERS)) {
      await db.query(
        `INSERT INTO crucible_user (email, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = TRUE`,
        [u.email, `E2E ${u.role}`, await hash(u.password), u.role],
      )
    }

    /*
     * The E2E suite signs in as ONE account roughly two hundred times in twenty minutes, from one
     * address. That is precisely the behaviour the per-email login ceiling exists to stop (E41),
     * and the first run after the ceilings landed proved it: 139 journeys failed on "sign-in
     * stayed on /login", none of them the one with the bug.
     *
     * So the suite turns the breaker off, using the switch built for exactly this. The ceiling
     * itself is tested in-process by `rateCeiling.test.ts`, where the limiter is reset between
     * tests; nothing about it is exercised here.
     */
    await db.query(
      `UPDATE feature_flag SET enabled = FALSE, updated_by = 'e2e', updated_at = now()
        WHERE key = 'feature.http.rate_limit'`)
  } finally {
    await db.end()
  }
}

/** Create runs so the ledger view has content to assert against. */
export async function seedRuns(count: number): Promise<void> {
  const db = pool()
  try {
    await db.query('DELETE FROM run_stage_result')
    await db.query('DELETE FROM run')
    for (let i = 0; i < count; i++) {
      await db.query(
        `INSERT INTO run (kind, status, correlation_id, started_by, cost_usd)
         VALUES ($1, 'SUCCEEDED', $2, 'e2e', $3)`,
        [i % 2 === 0 ? 'SCAN' : 'COHORT', `e2e-corr-${i}`, i * 0.5],
      )
    }
  } finally {
    await db.end()
  }
}

export async function clearRuns(): Promise<void> {
  const db = pool()
  try {
    await db.query('DELETE FROM run_stage_result')
    await db.query('DELETE FROM run')
  } finally {
    await db.end()
  }
}

export interface SeededRubric {
  challengeId: number
  rubricId: number
  slug: string
}

/**
 * Seed a challenge with a DRAFT rubric, one criterion flagged by the quality gate.
 *
 * Written directly to the database rather than driven through the UI: the journey under test is
 * *review and approval*, and building the rubric through the API first would make every
 * assertion depend on generation working too.
 */
export async function seedDraftRubric(slug = 'e2e-challenge'): Promise<SeededRubric> {
  const db = pool()
  try {
    // TRUNCATE, not DELETE: a frozen rubric's criteria are immutable and the trigger refuses
    // row-level deletes — correctly. Bypassing row triggers is a harness privilege the
    // application itself has no way to use.
    await db.query(`TRUNCATE TABLE rubric_criterion, rubric, challenge_artifact, challenge
                    RESTART IDENTITY CASCADE`)

    const challenge = await db.query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, status, created_by)
       VALUES ('E2E Challenge', $1, 'DRAFT', 'e2e') RETURNING challenge_id`, [slug])
    const challengeId = challenge.rows[0]!.challenge_id

    // A real extracted brief, so a criterion's source_ref resolves to an actual passage
    // (E02-S06 acceptance 3) rather than to nothing.
    const briefText = [
      '# E2E Challenge',
      '',
      '## 2.1 Ingestion',
      '',
      'The service must connect to the telemetry feed and parse every record it receives.',
      '',
      '## 2.2 Detection',
      '',
      'A breach occurs when a metric exceeds its configured threshold three times in a row.',
    ].join('\n')
    const sections = [
      { label: '# E2E Challenge', offset: 0, length: 17 },
      { label: '## 2.1 Ingestion', offset: 17, length: 101 },
      { label: '## 2.2 Detection', offset: 118, length: briefText.length - 118 },
    ]
    await db.query(
      `INSERT INTO challenge_artifact
         (challenge_id, kind, filename, media_type, bytes, storage_uri, content_hash,
          extraction_status, extracted_text, extracted_sections, extracted_at)
       VALUES ($1,'BRIEF','brief.md','text/markdown',$2,'file:///dev/null',repeat('a',64),
               'EXTRACTED',$3,$4::jsonb, now())`,
      [challengeId, briefText.length, briefText, JSON.stringify(sections)])

    const rubric = await db.query<{ rubric_id: number }>(
      `INSERT INTO rubric (challenge_id, version, status, dimension_weights, generated_by, generated_at)
       VALUES ($1, 1, 'DRAFT',
               '{"CHALLENGE_FIDELITY":1,"ENGINEERING_QUALITY":0,"PRINCIPLES_STANDARDS":0,"RUNS":0,"ORIGINALITY":0}'::jsonb,
               'e2e', now())
       RETURNING rubric_id`, [challengeId])
    const rubricId = rubric.rows[0]!.rubric_id

    const criteria = [
      { name: 'Ingests the telemetry feed', weight: 0.6, flagged: false },
      { name: 'Detects the threshold breach', weight: 0.4, flagged: true },
    ]
    for (const [i, c] of criteria.entries()) {
      await db.query(
        `INSERT INTO rubric_criterion
           (rubric_id, dimension, name, description, weight, evidence_spec,
            anchor_0, anchor_1, anchor_2, anchor_3, anchor_4, source_ref, sort_order,
            needs_rewrite, gate_notes)
         VALUES ($1,'CHALLENGE_FIDELITY',$2,$3,$4,$5,
                 'No evidence.','Mentioned only.','Present but unused.',
                 'Works on the main path.','Works, validated and tested.',
                 $6,$7,$8,$9::jsonb)`,
        [rubricId, c.name, `Whether the submission ${c.name.toLowerCase()}.`, c.weight,
         'A reader can point to the implementing code and its call sites.',
         `brief §2.${i + 1}`, i, c.flagged,
         JSON.stringify(c.flagged ? ['The gate could not confirm this is locatable.'] : [])],
      )
    }

    return { challengeId, rubricId, slug }
  } finally {
    await db.end()
  }
}

/** Seed a published rubric, an open window and a mix of submission outcomes for the dashboard. */
export async function seedIntake(): Promise<{ challengeId: number }> {
  const db = pool()
  try {
    // preflight_run holds submission_id as a plain column (ADR 0002), so CASCADE does not reach
    // it; left behind, its rows would be re-adopted by the next entry given the same id.
    await db.query(`TRUNCATE TABLE submission_validation_event, submission, team,
                                   preflight_notice, preflight_run, scan, build_probe,
                                   team_logistics, room, coach, access_token, token_delivery,
                                   submission_window, rubric_criterion, rubric,
                                   challenge_artifact, challenge
                    RESTART IDENTITY CASCADE`)

    const challenge = await db.query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, status, created_by)
       VALUES ('Intake Challenge', 'intake-challenge', 'OPEN', 'e2e') RETURNING challenge_id`)
    const challengeId = challenge.rows[0]!.challenge_id

    await db.query(
      `INSERT INTO submission_window (name, opens_at, closes_at)
       VALUES ('E2E window', now() - interval '1 hour', now() + interval '1 hour')`)

    const rows = [
      ['Team Alpha', 'alpha@team.test', 'VALID', 'The repository is public and was cloned successfully.'],
      ['Team Beta', 'beta@team.test', 'PRIVATE', 'GitHub would not serve this repository anonymously.'],
      ['Team Gamma', 'gamma@team.test', 'REJECTED', 'Repositories must be hosted on github.com or gitlab.com.'],
    ]
    for (const [team, email, status, detail] of rows) {
      await db.query(
        `WITH t AS (
           INSERT INTO team (display_name, contact_email, origin, created_by)
           VALUES ($1, $2, 'ORGANISER', 'e2e') RETURNING team_id
         )
         INSERT INTO submission
           (team_id, team_name, contact_email, challenge_id, repo_url, build_method,
            build_command, validation_status, validation_detail, validated_at)
         SELECT t.team_id, $1, $2, $3, $4, 'COMMAND', 'npm ci', $5, $6, now() FROM t`,
        [team, email, challengeId, `https://github.com/${String(team).toLowerCase().replace(' ', '-')}/p`,
         status, detail])
    }
    // Beta is placed and Gamma is not, so the dashboard has to show both a room and its
    // absence — "no room" is a fact an organiser acts on (E27-S03 acceptance 4).
    await db.query(
      `WITH r AS (
         INSERT INTO room (label, location, capacity, created_by)
         VALUES ('Ada Room', 'First floor', 6, 'e2e') RETURNING room_id
       ), c AS (
         INSERT INTO coach (full_name, email, created_by)
         VALUES ('Margaret Hamilton', 'margaret@example.test', 'e2e') RETURNING coach_id
       )
       INSERT INTO team_logistics (team_id, room_id, coach_id, updated_by)
       SELECT t.team_id, r.room_id, c.coach_id, 'e2e'
         FROM team t, r, c WHERE t.display_name = 'Team Beta'`)

    return { challengeId }
  } finally {
    await db.end()
  }
}
