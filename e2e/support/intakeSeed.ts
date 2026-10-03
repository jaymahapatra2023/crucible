/**
 * E2E fixture: an open challenge, an open intake window, and a submission token.
 *
 * Written straight to the database. The journey under test is a team filling in a form, and
 * making it depend on an organiser first walking through the setup UI would make a submission
 * test fail for a challenge-setup reason.
 */
import pg from 'pg'
import { createHash, randomBytes } from 'node:crypto'

function pool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test',
  })
}

export interface SeededIntake {
  challengeId: number
  challengeName: string
  /** The plaintext token. The database holds only its SHA-256, as production does. */
  token: string
  /** The team the token belongs to (E17-S01). */
  teamId: number
}

export async function seedIntake(): Promise<SeededIntake> {
  const db = pool()
  try {
    await db.query(
      // token_delivery holds team_id and token_id as plain columns (ADR 0002), so CASCADE
      // does not reach it. Left behind, its rows are re-adopted by the next team to be
      // given the same id by RESTART IDENTITY.
      'TRUNCATE TABLE submission, team, access_token, token_delivery, submission_window, '
      + 'preflight_notice, preflight_run, scan, build_probe CASCADE')
    await db.query(
      `UPDATE feature_flag SET enabled = TRUE WHERE key = 'feature.submissions.self_service'`)

    const name = 'Rostering for a hospital ward'
    const challenge = await db.query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, description, status, created_by)
       VALUES ($1, 'e2e-intake', 'Build something that helps', 'OPEN', 'e2e')
       ON CONFLICT (slug) DO UPDATE SET status = 'OPEN', name = EXCLUDED.name
       RETURNING challenge_id`, [name])

    // A published rubric is a precondition of accepting entries (E02-S08): teams are entitled
    // to know the standard before they are judged by it, so a fixture without one would be
    // testing a state the product deliberately refuses.
    await publishRubric(db, challenge.rows[0]!.challenge_id)

    await db.query(
      `INSERT INTO submission_window (name, opens_at, closes_at)
       VALUES ('E2E window', now() - interval '1 hour', now() + interval '1 day')`)

    // The token IS the team (E17-S01): a submission token with no team behind it is refused,
    // because an entry made with it could not be attributed to anybody.
    const token = `crs_${randomBytes(24).toString('base64url')}`
    const team = await db.query<{ team_id: number }>(
      `INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ('E2E team', 'e2e-team@team.test', 'ORGANISER', 'e2e') RETURNING team_id`)
    await db.query(
      `INSERT INTO access_token (token_hash, kind, label, scopes, issued_by, team_id)
       VALUES ($1, 'SUBMISSION', 'E2E team', ARRAY['submissions:create'], 'e2e', $2)`,
      [createHash('sha256').update(token).digest('hex'), team.rows[0]!.team_id])

    return {
      challengeId: challenge.rows[0]!.challenge_id, challengeName: name, token,
      teamId: Number(team.rows[0]!.team_id),
    }
  } finally {
    await db.end()
  }
}

/**
 * A frozen, published rubric with one criterion — the minimum intake will accept.
 *
 * Idempotent, and it has to be: a frozen rubric cannot be deleted (E02-S07 is enforced by a
 * trigger, correctly — a change makes a new version), so a fixture that tried to recreate one
 * on every run would fail on its second. It reuses whatever is already published instead.
 */
export async function publishRubric(db: pg.Pool, challengeId: number): Promise<void> {
  const existing = await db.query(
    `SELECT 1 FROM rubric
      WHERE challenge_id = $1 AND status = 'FROZEN' AND published_at IS NOT NULL`,
    [challengeId])
  if (existing.rowCount && existing.rowCount > 0) return

  await db.query(
    `DELETE FROM rubric WHERE challenge_id = $1 AND status <> 'FROZEN'`, [challengeId])

  const rubric = await db.query<{ rubric_id: number }>(
    `INSERT INTO rubric (challenge_id, version, status, dimension_weights, generated_by,
                         generated_at)
     VALUES ($1, 1, 'DRAFT',
             '{"CHALLENGE_FIDELITY":1,"ENGINEERING_QUALITY":0,"PRINCIPLES_STANDARDS":0,"RUNS":0,"ORIGINALITY":0}'::jsonb,
             'e2e', now())
     RETURNING rubric_id`, [challengeId])
  const rubricId = rubric.rows[0]!.rubric_id

  await db.query(
    `INSERT INTO rubric_criterion
       (rubric_id, dimension, name, description, weight, evidence_spec,
        anchor_0, anchor_1, anchor_2, anchor_3, anchor_4, source_ref, sort_order)
     VALUES ($1,'CHALLENGE_FIDELITY','Answers the brief',
             'Whether the submission does what the brief asked for.', 1,
             'A reader can point at the feature the brief describes.',
             'Nothing in the brief is addressed.','One element is started.',
             'Some of the brief is addressed.','Most of the brief is addressed.',
             'The brief is addressed throughout.','brief §1',0)`, [rubricId])

  await db.query(
    `UPDATE rubric SET status = 'FROZEN', approved_by = 'e2e', approved_at = now(),
                       frozen_at = now(), published_at = now(),
                       content_hash = repeat('e', 64)
      WHERE rubric_id = $1`, [rubricId])

  // The publication record, not only the flag on the rubric. It is what the public endpoint
  // serves and what the submission form's link addresses (E09-S04, E17-S04), so a fixture
  // without one would leave the standard unreadable to exactly the people it exists for.
  const slug = await db.query<{ slug: string }>(
    'SELECT slug FROM challenge WHERE challenge_id = $1', [challengeId])
  await db.query(
    `INSERT INTO rubric_publication
       (rubric_id, challenge_id, slug, version, content_hash,
        document_markdown, document_html, document_hash, published_by)
     VALUES ($1, $2, $3, 1, repeat('e', 64),
             '# How your entry will be judged', '<h1>How your entry will be judged</h1>',
             repeat('d', 64), 'e2e')`,
    [rubricId, challengeId, slug.rows[0]!.slug])
}

/** Close intake, so the form's refusal can be exercised. */
export async function closeIntake(): Promise<void> {
  const db = pool()
  try {
    await db.query('TRUNCATE TABLE submission_window CASCADE')
    await db.query(
      `INSERT INTO submission_window (name, opens_at, closes_at)
       VALUES ('E2E closed', now() - interval '2 days', now() - interval '1 day')`)
  } finally {
    await db.end()
  }
}
