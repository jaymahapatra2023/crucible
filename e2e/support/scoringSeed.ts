/**
 * E2E fixtures for the scoring, review and batch journeys.
 *
 * Split from `seed.ts` when that file outgrew its size limit. The division is by subject rather
 * than by size: this file builds evaluated state — runs, scores, rankings, decisions — while
 * `seed.ts` builds the things an evaluation is performed ON.
 */
import pg from 'pg'

const pool = (): pg.Pool =>
  new pg.Pool({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/crucible_test',
  })

export interface SeededScoring {
  challengeId: number
  secondChallengeId: number
  runIndexId: number
  submissionIds: number[]
}

/**
 * A completed scoring run with a deliberate mix of outcomes (E06, E07).
 *
 * Written straight to the database rather than produced by running the scorer: the journey under
 * test is the reviewer reading the results, and making it depend on a live model call would make
 * a UI test fail for reasons that have nothing to do with the UI.
 *
 * The mix is the point. One fully-scored submission, one whose criterion could not be evidenced,
 * and one whose scoring call failed — because the thing most worth proving in the browser is
 * that those three look different on the page.
 */
export async function seedScoredRun(): Promise<SeededScoring> {
  const db = pool()
  try {
    // Restore the full calibration state, not only the flag. `seedGateDecision` records a gate
    // decision and turns the bypass off to exercise the real-evaluation configuration; a spec
    // that ran afterwards would otherwise inherit a gate it never asked for — the cross-file
    // coupling that makes one spec's failure appear in another, and which cost a debugging
    // cycle here once already.
    await db.query(
      'TRUNCATE TABLE gate_decision, calibration_report, gate_criteria, golden_set CASCADE')
    await db.query(
      `UPDATE feature_flag SET enabled = TRUE WHERE key = 'feature.calibration.bypass_gate'`)

    // The final ranking is keyed by cohort, not by run: it survives a run's removal and would
    // otherwise greet the next journey as an already-computed list (E50-S02).
    await db.query('TRUNCATE TABLE cohort_final_snapshot, cohort_final_ranking, coach_dispatch CASCADE')
    await db.query(`TRUNCATE TABLE score_variance, criterion_score, originality_assessment,
                                   principle_assessment, standard_assessment, score_run,
                                   scan, build_probe, preflight_notice, preflight_run,
                                   submission, team, team_logistics, room, coach,
                                   access_token, token_delivery, rubric_criterion, rubric,
                                   challenge_artifact, challenge
                    RESTART IDENTITY CASCADE`)

    const challenge = await db.query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, status, created_by)
       VALUES ('Scoring Challenge', 'e2e-scoring', 'OPEN', 'e2e') RETURNING challenge_id`)
    const challengeId = challenge.rows[0]!.challenge_id

    const rubric = await db.query<{ rubric_id: number }>(
      // Created DRAFT and frozen below, after its criteria exist — the freeze trigger refuses
      // criterion writes against a FROZEN rubric, correctly, so the fixture follows the same
      // order the real approval flow does.
      `INSERT INTO rubric (challenge_id, version, status, dimension_weights, generated_by,
                           generated_at)
       VALUES ($1, 1, 'DRAFT',
               '{"CHALLENGE_FIDELITY":1,"ENGINEERING_QUALITY":0,"PRINCIPLES_STANDARDS":0,"RUNS":0,"ORIGINALITY":0}'::jsonb,
               'e2e', now())
       RETURNING rubric_id`, [challengeId])
    const rubricId = rubric.rows[0]!.rubric_id

    const criterion = await db.query<{ criterion_id: number }>(
      `INSERT INTO rubric_criterion
         (rubric_id, dimension, name, description, weight, evidence_spec,
          anchor_0, anchor_1, anchor_2, anchor_3, anchor_4, source_ref, sort_order)
       VALUES ($1,'CHALLENGE_FIDELITY','Handles failures without losing work',
               'Whether the submission retries and surfaces failures.', 1,
               'A reader can point at the retry loop and the error handling.',
               'No evidence of retries.','Errors are swallowed.','Retries without backoff.',
               'Retries with backoff on the main path.',
               'Retries with backoff, and failures are surfaced.','brief §1',0)
       RETURNING criterion_id`, [rubricId])
    const criterionId = criterion.rows[0]!.criterion_id

    await db.query(
      `UPDATE rubric SET status = 'FROZEN', approved_by = 'e2e', approved_at = now(),
                         frozen_at = now(), content_hash = repeat('f', 64)
        WHERE rubric_id = $1`, [rubricId])

    const run = await db.query<{ run_index_id: number }>(
      `INSERT INTO score_run (run_index, cohort_key, rubric_versions, model, status, started_by,
                              finished_at)
       VALUES (1, 'e2e-cohort', $1::jsonb, 'claude-sonnet-5', 'COMPLETED', 'e2e', now())
       RETURNING run_index_id`,
      [JSON.stringify({ [challengeId]: 1 })])
    const runIndexId = run.rows[0]!.run_index_id

    const scanResult = {
      commitSha: 'a'.repeat(40), headCommittedAt: null,
      files: [{ path: 'src/retry.ts', bytes: 40, lines: 12, language: 'typescript',
                content: 'export async function withRetry() {}', truncated: false }],
      stats: { totalFiles: 1, sourceFiles: 1, totalBytes: 40, byLanguage: {},
               topDirectories: ['src'], recommendedDepth: 'standard' },
      metrics: { filesAnalysed: 1, totalLines: 12, codeLines: 12, commentLines: 0, blankLines: 0,
                 languages: ['typescript'], longFiles: [], maxFileLines: 12, averageFileLines: 12,
                 hasTests: false, testFileCount: 0, hasCi: false, hasDockerfile: true,
                 hasReadme: false, hasLockfile: true, dependencyCount: 14 },
      provenance: null, filesAnalysed: 1, filesTotal: 3, budgetTruncated: false,
      scannedAt: '2026-01-01T00:00:00Z', durationMs: 5,
    }

    const outcomes = [
      { team: 'Team Scored', raw: 4, nonScore: null },
      { team: 'Team Unevidenced', raw: null, nonScore: 'INSUFFICIENT_EVIDENCE' },
      { team: 'Team Failed', raw: null, nonScore: 'SCORING_FAILED' },
    ]

    const submissionIds: number[] = []
    for (const [i, outcome] of outcomes.entries()) {
      const submission = await db.query<{ submission_id: number }>(
        // A submission belongs to a team (E17-S01); the fixture creates one alongside it.
        `WITH t AS (
           INSERT INTO team (display_name, contact_email, origin, created_by)
           VALUES ($1, $2, 'ORGANISER', 'e2e') RETURNING team_id
         )
         INSERT INTO submission
           (team_id, team_name, contact_email, challenge_id, repo_url, build_method,
            build_command, validation_status)
         SELECT t.team_id, $1, $2, $3, $4, 'COMMAND', 'npm ci', 'VALID' FROM t
         RETURNING submission_id`,
        [outcome.team, `${outcome.team.toLowerCase().replace(/ /g, '-')}@team.test`,
         challengeId, `https://github.com/e2e/repo-${i}`])
      const submissionId = submission.rows[0]!.submission_id
      submissionIds.push(submissionId)

      await db.query(
        `INSERT INTO scan (submission_id, depth, raw_result, content_hash, status, languages,
                           primary_language, commit_sha)
         VALUES ($1, 'standard', $2::jsonb, $3, 'COMPLETED', ARRAY['typescript'], 'typescript', $4)`,
        [submissionId, JSON.stringify(scanResult),
         String(submissionId).padStart(64, 'e'), 'a'.repeat(40)])

      await db.query(
        `INSERT INTO criterion_score
           (run_index_id, submission_id, criterion_id, dimension, rubric_id, rubric_version,
            rubric_hash, raw_score, non_score, confidence, rationale, anchor_matched, evidence)
         VALUES ($1,$2,$3,'CHALLENGE_FIDELITY',$4,1,repeat('f',64),$5,$6,$7,$8,$9,$10::jsonb)`,
        [runIndexId, submissionId, criterionId, rubricId, outcome.raw, outcome.nonScore,
         outcome.raw === null ? 0 : 85,
         outcome.raw !== null
           ? 'A retry loop with exponential backoff is present and used on the main path.'
           : outcome.nonScore === 'INSUFFICIENT_EVIDENCE'
             ? 'No file among the 1 read mentions anything this criterion asks about (searched for: retry, backoff, error).'
             : 'Scoring could not be completed: the provider timed out.',
         outcome.raw !== null ? 'Retries with backoff, and failures are surfaced.' : null,
         // Two citations with different verdicts, because the journey worth testing is a
         // reviewer telling them apart: one checked against the submitted commit, one the
         // scan budget never reached.
         JSON.stringify(outcome.raw !== null
           ? [
               { path: 'src/retry.ts', lineStart: 1, lineEnd: 12,
                 excerpt: 'export async function withRetry() {}',
                 verdict: 'VERIFIED',
                 verdictReason: 'The quoted text is at src/retry.ts:1.' },
               { path: 'src/elsewhere/config.ts', lineStart: 4, lineEnd: 6,
                 excerpt: 'export const RETRIES = 3',
                 verdict: 'UNVERIFIABLE',
                 verdictReason: "'src/elsewhere/config.ts' was not among the 1 files the scan "
                   + 'read, and the scan was truncated by its file budget, so it may exist unread.' },
             ]
           : [])])
    }

    // One advisory originality assessment, on the fully-scored submission.
    await db.query(
      `INSERT INTO originality_assessment
         (run_index_id, submission_id, level, confidence, rationale, observations,
          boilerplate_share_pct, scaffold_lines, substantive_lines, templates, provenance_flags)
       VALUES ($1,$2,2,60,$3,$4::jsonb,62.0,300,180,$5::jsonb,$6::jsonb)`,
      [runIndexId, submissionIds[0],
       'The domain logic outside the scaffold is the team’s own work.',
       JSON.stringify(['Most analysed lines are application logic.']),
       JSON.stringify([{ id: 'vite-starter', name: 'Vite starter template',
                         matchedOn: 'vite.config.ts' }]),
       JSON.stringify([{ code: 'NO_HISTORY',
                         message: 'This submission has no readable git history.' }])])

    const secondChallengeId = await seedSecondChallenge(db, runIndexId, submissionIds)
    await seedRankingRows(db, { runIndexId, challengeId, secondChallengeId, submissionIds })

    // Where the first team sat and who coached them, so the review page can show what an
    // appeal is often reconstructing (E27-S03 acceptance 4). Only the first: the page must show
    // the absence for the others rather than inventing a room.
    await db.query(
      `WITH r AS (
         INSERT INTO room (label, location, capacity, created_by)
         VALUES ('Ada Room', 'First floor', 6, 'e2e') RETURNING room_id
       ), c AS (
         INSERT INTO coach (full_name, email, created_by)
         VALUES ('Margaret Hamilton', 'margaret@example.test', 'e2e') RETURNING coach_id
       )
       INSERT INTO team_logistics (team_id, room_id, coach_id, updated_by)
       SELECT s.team_id, r.room_id, c.coach_id, 'e2e'
         FROM submission s, r, c WHERE s.submission_id = $1`,
      [submissionIds[0]])

    return { challengeId, secondChallengeId, runIndexId, submissionIds }
  } finally {
    await db.end()
  }
}


/** A second challenge with one submission, so the split panel has something to split (E07-S05). */
async function seedSecondChallenge(
  db: pg.Pool, runIndexId: number, submissionIds: number[],
): Promise<number> {
  const second = await db.query<{ challenge_id: number }>(
    `INSERT INTO challenge (name, slug, status, created_by)
     VALUES ('Second Challenge', 'e2e-scoring-two', 'OPEN', 'e2e') RETURNING challenge_id`)
  const secondChallengeId = second.rows[0]!.challenge_id

  const outsider = await db.query<{ submission_id: number }>(
    `WITH t AS (
       INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ('Team Outsider', 'outsider@team.test', 'ORGANISER', 'e2e') RETURNING team_id
     )
     INSERT INTO submission
       (team_id, team_name, contact_email, challenge_id, repo_url, build_method, build_command,
        validation_status)
     SELECT t.team_id, 'Team Outsider', 'outsider@team.test', $1,
            'https://github.com/e2e/repo-x', 'COMMAND', 'npm ci', 'VALID' FROM t
     RETURNING submission_id`,
    [secondChallengeId])
  submissionIds.push(outsider.rows[0]!.submission_id)

  return secondChallengeId
}

/**
 * The stored ranking, its dimension breakdown, its caveats and an open shortlist.
 *
 * Ranks are stated rather than derived, so the fixture pins exactly the situation the journeys
 * are about: a band around the cut line, a tie inside it, and one placement that turns on the
 * advisory dimension.
 */
async function seedRankingRows(db: pg.Pool, ids: {
  runIndexId: number
  challengeId: number
  secondChallengeId: number
  submissionIds: number[]
}): Promise<void> {
  const { runIndexId, challengeId, secondChallengeId, submissionIds } = ids
  const outsiderId = submissionIds[3]!

  for (const [challenge, size] of [[challengeId, 3], [secondChallengeId, 1]] as const) {
    await db.query(
      `INSERT INTO run_cohort (run_index_id, challenge_id, cohort_size, floor_used, below_floor)
       VALUES ($1, $2, $3, 15, TRUE)`,
      [runIndexId, challenge, size])
  }

  const ranking = [
    { id: submissionIds[0]!, challenge: challengeId, composite: 88.0, rank: 1, inChallenge: 1,
      band: false, advisory: false, tied: false, partial: false, missing: [] as string[],
      raw: 88, normalised: 88 },
    { id: outsiderId, challenge: secondChallengeId, composite: 61.0, rank: 2, inChallenge: 1,
      band: true, advisory: true, tied: false, partial: false, missing: [],
      raw: 61, normalised: 61 },
    { id: submissionIds[1]!, challenge: challengeId, composite: 55.5, rank: 3, inChallenge: 2,
      band: true, advisory: false, tied: false, partial: true, missing: ['ORIGINALITY'],
      raw: null, normalised: null },
    { id: submissionIds[2]!, challenge: challengeId, composite: 55.5, rank: 4, inChallenge: 3,
      band: true, advisory: false, tied: true, partial: true, missing: ['RUNS'],
      raw: null, normalised: null },
  ]

  for (const r of ranking) {
    const reasons = [
      ...(r.advisory ? ['ADVISORY_DECIDED'] : []),
      ...(r.band ? ['IN_CUT_BAND'] : []),
      ...(r.tied ? ['TIED'] : []),
      'COHORT_BELOW_FLOOR',
      ...(r.missing.length > 0 ? ['DIMENSION_UNSCORED'] : r.partial ? ['PARTIAL_EVIDENCE'] : []),
    ]

    await db.query(
      `INSERT INTO submission_composite
         (run_index_id, submission_id, challenge_id, composite, fidelity_raw,
          fidelity_normalised, cohort_size, normalisation_method, rank_global,
          rank_in_challenge, tied, weight_covered, missing_dimensions, partial,
          in_cut_band, advisory_decided, requires_review, review_reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ABSOLUTE_FALLBACK',$8,$9,$10,$11,$12::text[],$13,$14,$15,
               $16,$17::text[])`,
      [runIndexId, r.id, r.challenge, r.composite, r.raw, r.normalised,
       r.challenge === challengeId ? 3 : 1, r.rank, r.inChallenge, r.tied,
       r.missing.length > 0 ? 0.8 : 1, r.missing, r.partial, r.band, r.advisory,
       reasons.length > 0, reasons])

    const dims: Array<[string, number | null, number]> = [
      ['CHALLENGE_FIDELITY', r.normalised, 1],
      ['ENGINEERING_QUALITY', null, 0],
      ['PRINCIPLES_STANDARDS', null, 0],
      ['RUNS', null, 0],
      ['ORIGINALITY', null, 0],
    ]
    for (const [dimension, score, weight] of dims) {
      await db.query(
        `INSERT INTO submission_dimension_score
           (run_index_id, submission_id, dimension, score, data_quality,
            scored_count, total_count, weight_covered, weight)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)`,
        [runIndexId, r.id, dimension, score, score === null ? 'UNSCORED' : 'COMPLETE',
         score === null ? 0 : 1, score === null ? 0 : 1, weight])
    }

    await db.query(
      `INSERT INTO review_flag (run_index_id, submission_id, code, severity, message, detail)
       VALUES ($1,$2,'COHORT_BELOW_FLOOR','ATTENTION',$3,$4::jsonb)`,
      [runIndexId, r.id,
       'This challenge had 3 submissions, below the 15 needed to compare fidelity within a ' +
       'cohort, so the raw fidelity score was used unchanged.',
       JSON.stringify({ cohortSize: 3, floor: 15 })])
  }

  await db.query(
    `INSERT INTO shortlist (run_index_id, name, created_by) VALUES ($1, 'E2E Finals', 'e2e')`,
    [runIndexId])

  await db.query(
    `INSERT INTO ranking_snapshot
       (run_index_id, scores_counted, submissions, cut_line_used, band_size_used,
        min_cohort_size, computed_by)
     VALUES ($1, (SELECT COUNT(*) FROM criterion_score WHERE run_index_id = $1), 4, 3, 1, 15, 'e2e')`,
    [runIndexId])
}


/**
 * A finished cohort run with a mixed outcome, for the progress journey (E10).
 *
 * Written directly rather than by running a batch: the journey under test is the operator
 * reading progress, and driving real scans and probes would make a UI test depend on the
 * network and on Docker.
 */
export async function seedBatchRun(): Promise<{ runId: number }> {
  const db = pool()
  try {
    await db.query('TRUNCATE TABLE run_progress, run_stage_result, run RESTART IDENTITY CASCADE')

    const run = await db.query<{ run_id: number }>(
      `INSERT INTO run (kind, status, params, correlation_id, started_by, cost_usd)
       VALUES ('COHORT', 'PAUSED', '{"cohortKey":"e2e"}'::jsonb, 'e2e-corr', 'e2e', 41.5)
       RETURNING run_id`)
    const runId = run.rows[0]!.run_id

    await db.query(
      `UPDATE run SET error = $2 WHERE run_id = $1`,
      [runId,
       'At the current rate this run would cost about $415.00, above the $250.00 ceiling. It is '
       + 'paused now, with $41.50 spent, so the ceiling can be raised or the cohort reduced '
       + 'before the rest is spent.'])

    // Four submissions: scanning and probing finished, scoring stopped part-way, one failure.
    const stages: Array<[string, number, string, string]> = [
      ['scan', 1, 'ok', ''], ['scan', 2, 'ok', ''], ['scan', 3, 'ok', ''],
      ['scan', 4, 'failed', 'the repository vanished mid-clone'],
      ['probe', 1, 'ok', ''], ['probe', 2, 'ok', ''], ['probe', 3, 'ok', ''],
      ['score', 1, 'ok', ''], ['score', 2, 'ok', ''],
    ]
    for (const [stage, subject, outcome, message] of stages) {
      await db.query(
        `INSERT INTO run_stage_result
           (run_id, stage, subject_type, subject_id, outcome, message, duration_ms)
         VALUES ($1,$2,'submission',$3,$4,$5,1200)`,
        [runId, stage, String(subject), outcome, message])
    }

    await db.query(
      `INSERT INTO run_progress
         (run_id, stage, current_subject, current_label, completed, total,
          estimated_finish_at, projected_cost_usd)
       VALUES ($1, 'score', '3', 'Team Gamma', 2, 4, now() + interval '2 hours', 415.00)`,
      [runId])

    return { runId }
  } finally {
    await db.end()
  }
}


/**
 * A recorded go/no-go decision, for the gate journey (E11-S03).
 *
 * The bypass flag is turned OFF as part of this, because the behaviour under test is what the
 * system does at the real evaluation — where the flag must be off — rather than what it does
 * during rehearsal.
 */
export async function seedGateDecision(decision: 'GO' | 'NO_GO' | 'NONE'): Promise<void> {
  const db = pool()
  try {
    await db.query('TRUNCATE TABLE gate_decision, calibration_report, gate_criteria, golden_set CASCADE')
    await db.query(
      `UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.calibration.bypass_gate'`)

    if (decision === 'NONE') return

    const set = await db.query<{ golden_set_id: number }>(
      `INSERT INTO golden_set (name, status, sealed_at, sealed_by, created_by)
       VALUES ('E2E Golden', 'SEALED', now(), 'e2e', 'e2e') RETURNING golden_set_id`)
    const goldenSetId = set.rows[0]!.golden_set_id

    const criteria = await db.query<{ criteria_id: number }>(
      `INSERT INTO gate_criteria
         (golden_set_id, min_rank_correlation, max_material_disagreements, material_rank_gap,
          max_run_variance, fallback_plan, recorded_by)
       VALUES ($1, 0.70, 1, 3, 10,
               'Fall back to fully human judging; Crucible gathers evidence only.', 'e2e')
       RETURNING criteria_id`, [goldenSetId])

    const report = await db.query<{ report_id: number }>(
      `INSERT INTO calibration_report
         (golden_set_id, criteria_id, run_index_id, rank_correlation, sample_size,
          material_disagreements, generated_by)
       VALUES ($1, $2, 1, $3, 8, $4, 'e2e') RETURNING report_id`,
      [goldenSetId, criteria.rows[0]!.criteria_id,
       decision === 'GO' ? 0.91 : 0.42, decision === 'GO' ? 0 : 3])

    // The configuration the verdict was measured under, built from the settings in force right
    // now. Since E25 a GO whose settings are unknown is REFUSED — "we do not know what it was
    // measured under" is not "it is fine" — so a decision seeded without a pin would leave
    // ranking disabled, which is correct behaviour and a broken fixture.
    await db.query(
      `INSERT INTO gate_decision (report_id, decision, rationale, decided_by, pinned_config)
       VALUES ($1, $2, $3, 'chair@test.local', jsonb_build_object(
         'config', (
           SELECT COALESCE(jsonb_object_agg(key, jsonb_build_object('value', value, 'type', value_type)), '{}'::jsonb)
             FROM app_config WHERE affects_outcome
         ),
         'flags', (
           SELECT COALESCE(jsonb_object_agg(key, enabled), '{}'::jsonb) FROM feature_flag
         ),
         'capturedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ))`,
      [report.rows[0]!.report_id, decision,
       decision === 'GO'
         ? 'Every recorded criterion is met and the disagreements are all one place.'
         : 'Correlation is below the recorded threshold and three placements are far out.'])
  } finally {
    await db.end()
  }
}

/**
 * Run 2 of the same cohort, as a copy of run 1's scores and ranking (E50-S02). Two ranked runs
 * are what the final ranking needs; what they say is not the point of the journeys that use it.
 */
export async function seedSecondRun(seeded: SeededScoring): Promise<{ runIndexId: number }> {
  const db = pool()
  try {
    const run = await db.query<{ run_index_id: number }>(
      `INSERT INTO score_run (run_index, cohort_key, rubric_versions, model, status, started_by, finished_at)
       SELECT 2, cohort_key, rubric_versions, model, status, 'e2e', now() FROM score_run WHERE run_index_id = $1
       RETURNING run_index_id`, [seeded.runIndexId])
    const second = run.rows[0]!.run_index_id
    await db.query(
      `INSERT INTO criterion_score
         (run_index_id, submission_id, criterion_id, dimension, rubric_id, rubric_version, rubric_hash,
          raw_score, non_score, confidence, rationale, anchor_matched, evidence)
       SELECT $2, submission_id, criterion_id, dimension, rubric_id, rubric_version, rubric_hash,
              raw_score, non_score, confidence, rationale, anchor_matched, evidence
         FROM criterion_score WHERE run_index_id = $1`, [seeded.runIndexId, second])
    await db.query(
      `INSERT INTO submission_composite
         (run_index_id, submission_id, challenge_id, composite, fidelity_raw, fidelity_normalised, cohort_size,
          normalisation_method, rank_global, rank_in_challenge, tied, weight_covered, missing_dimensions, partial,
          in_cut_band, advisory_decided, requires_review, review_reasons)
       SELECT $2, submission_id, challenge_id, composite, fidelity_raw, fidelity_normalised, cohort_size,
              normalisation_method, rank_global, rank_in_challenge, tied, weight_covered, missing_dimensions, partial,
              in_cut_band, advisory_decided, requires_review, review_reasons
         FROM submission_composite WHERE run_index_id = $1`, [seeded.runIndexId, second])
    await db.query(
      `INSERT INTO ranking_snapshot (run_index_id, scores_counted, submissions, cut_line_used, band_size_used, min_cohort_size, computed_by)
       SELECT $2, scores_counted, submissions, cut_line_used, band_size_used, min_cohort_size, 'e2e'
         FROM ranking_snapshot WHERE run_index_id = $1`, [seeded.runIndexId, second])
    return { runIndexId: second }
  } finally {
    await db.end()
  }
}
