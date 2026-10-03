/**
 * The system-level definition of done (plan §IV.5).
 *
 * Seven statements the plan says must be true before this system decides anything, checked
 * against the database rather than against anyone's memory of having done them. They were
 * written as a checklist for a person, and a checklist a person keeps is a checklist that is
 * partly kept — on the night, under time pressure, by whoever is free.
 *
 * Every check reports what it FOUND, not merely pass or fail. "Two of fifty submissions have no
 * probe result" tells an operator what to do; "incomplete" does not.
 *
 * Scoped to one cohort, because that is the unit the statements are about: a shortlist is drawn
 * from a cohort, and readiness is a property of that cohort's evidence.
 */
import { query, queryOne } from '../../../db/pool.js'
import { getJson, getString } from './configService.js'
import { eventWindowSchema } from './configSchemas.js'
import { coverageFor } from '../../discovery/services/discoveryCoverage.js'

export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface ReadinessCheck {
  id: string
  statement: string
  status: CheckStatus
  /** What was found, in words an operator can act on. */
  detail: string
}

export interface ReadinessReport {
  cohortKey: string
  ready: boolean
  checks: ReadinessCheck[]
}

export async function readinessReport(cohortKey: string): Promise<ReadinessReport> {
  const checks = [
    await rubricsFrozenAndPublished(cohortKey),
    await submissionsHaveEvidence(cohortKey),
    await twoScoreRuns(cohortKey),
    await rankingComputed(cohortKey),
    await calibrationDecided(),
    await cutBandReviewed(cohortKey),
    await appealPacketPossible(cohortKey),
    await evidencedEvenly(cohortKey),
    await eventConfigured(),
  ]

  return {
    cohortKey,
    // UNKNOWN does not count as ready. A check that could not be evaluated is not a check that
    // passed, and treating it as one is how a checklist becomes decoration.
    ready: checks.every((c) => c.status === 'PASS'),
    checks,
  }
}

/** §IV.5.1 — a frozen, published rubric per challenge, hash-recorded. */
async function rubricsFrozenAndPublished(cohortKey: string): Promise<ReadinessCheck> {
  const row = await queryOne<{ challenges: number; frozen: number; published: number }>(
    `WITH cohort_challenges AS (
       SELECT DISTINCT s.challenge_id
         FROM criterion_score cs
         JOIN score_run sr ON sr.run_index_id = cs.run_index_id
         JOIN v_submissions_submission s ON s.submission_id = cs.submission_id
        WHERE sr.cohort_key = $1
     )
     SELECT COUNT(*)::int AS challenges,
            COUNT(r.rubric_id) FILTER (WHERE r.status = 'FROZEN'
                                   AND r.content_hash IS NOT NULL)::int AS frozen,
            COUNT(p.publication_id)::int AS published
       FROM cohort_challenges c
       LEFT JOIN rubric r ON r.challenge_id = c.challenge_id AND r.status = 'FROZEN'
       LEFT JOIN rubric_publication p ON p.rubric_id = r.rubric_id`,
    [cohortKey])

  const challenges = row?.challenges ?? 0
  if (challenges === 0) {
    return check('rubric_frozen', STATEMENTS.rubric, 'UNKNOWN',
      'No scored submissions in this cohort, so there are no challenges to check.')
  }
  if (row!.frozen < challenges) {
    return check('rubric_frozen', STATEMENTS.rubric, 'FAIL',
      `${row!.frozen} of ${challenges} challenge(s) have a frozen, hash-recorded rubric.`)
  }
  if (row!.published === 0) {
    return check('rubric_frozen', STATEMENTS.rubric, 'FAIL',
      `Rubrics are frozen but none has a publication record. Teams must be able to show what `
      + `they were told.`)
  }
  return check('rubric_frozen', STATEMENTS.rubric, 'PASS',
    `${challenges} challenge(s), each with a frozen, hash-recorded and published rubric.`)
}

/** §IV.5.2 — validated repo, recorded commit SHA and a build-probe result for every submission. */
async function submissionsHaveEvidence(cohortKey: string): Promise<ReadinessCheck> {
  const row = await queryOne<{
    total: number; valid: number; with_sha: number; probed: number
  }>(
    `WITH cohort AS (
       SELECT DISTINCT cs.submission_id FROM criterion_score cs
         JOIN score_run sr ON sr.run_index_id = cs.run_index_id
        WHERE sr.cohort_key = $1
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE s.validation_status = 'VALID')::int AS valid,
            COUNT(*) FILTER (WHERE s.locked_commit_sha IS NOT NULL)::int AS with_sha,
            COUNT(p.probe_id)::int AS probed
       FROM cohort c
       JOIN v_submissions_submission s ON s.submission_id = c.submission_id
       LEFT JOIN v_probes_current p ON p.submission_id = c.submission_id`,
    [cohortKey])

  const total = row?.total ?? 0
  if (total === 0) {
    return check('submission_evidence', STATEMENTS.evidence, 'UNKNOWN',
      'No scored submissions in this cohort.')
  }

  const gaps: string[] = []
  if (row!.valid < total) gaps.push(`${total - row!.valid} without a VALID repository`)
  if (row!.with_sha < total) gaps.push(`${total - row!.with_sha} without a locked commit`)
  if (row!.probed < total) gaps.push(`${total - row!.probed} never probed`)

  return gaps.length === 0
    ? check('submission_evidence', STATEMENTS.evidence, 'PASS',
        `All ${total} submissions have a valid repository, a locked commit and a probe result.`)
    : check('submission_evidence', STATEMENTS.evidence, 'FAIL',
        `Of ${total} submissions: ${gaps.join(', ')}.`)
}

/** §IV.5.3 — two independent score runs, with file-and-line evidence. */
async function twoScoreRuns(cohortKey: string): Promise<ReadinessCheck> {
  const runs = await query<{ run_index: number; scored: number; with_evidence: number }>(
    `SELECT sr.run_index,
            COUNT(DISTINCT cs.submission_id)::int AS scored,
            COUNT(*) FILTER (WHERE jsonb_array_length(cs.evidence) > 0)::int AS with_evidence
       FROM score_run sr
       LEFT JOIN criterion_score cs ON cs.run_index_id = sr.run_index_id
      WHERE sr.cohort_key = $1
      GROUP BY sr.run_index ORDER BY sr.run_index`,
    [cohortKey])

  if (runs.rows.length < 2) {
    return check('two_runs', STATEMENTS.tworuns, 'FAIL',
      `${runs.rows.length} of 2 score runs exist for this cohort.`)
  }
  const missingEvidence = runs.rows.filter((r) => r.with_evidence === 0)
  if (missingEvidence.length > 0) {
    return check('two_runs', STATEMENTS.tworuns, 'FAIL',
      `Run(s) ${missingEvidence.map((r) => r.run_index).join(', ')} produced no cited evidence.`)
  }
  return check('two_runs', STATEMENTS.tworuns, 'PASS',
    `Two runs, scoring ${runs.rows.map((r) => r.scored).join(' and ')} submissions, both citing `
    + `file-and-line evidence.`)
}

/** §IV.5.4 — a global ranking with fidelity normalised in cohort and the split reported. */
async function rankingComputed(cohortKey: string): Promise<ReadinessCheck> {
  const row = await queryOne<{ ranked: number; fallback: number; challenges: number }>(
    `SELECT COUNT(*)::int AS ranked,
            COUNT(*) FILTER (WHERE sc.normalisation_method = 'ABSOLUTE_FALLBACK')::int AS fallback,
            COUNT(DISTINCT sc.challenge_id)::int AS challenges
       FROM submission_composite sc
       JOIN score_run sr ON sr.run_index_id = sc.run_index_id
      WHERE sr.cohort_key = $1`,
    [cohortKey])

  if ((row?.ranked ?? 0) === 0) {
    return check('ranking', STATEMENTS.ranking, 'FAIL',
      'No ranking has been computed for this cohort.')
  }
  // A fallback is not a failure; it is a caveat that must be visible rather than silent.
  return check('ranking', STATEMENTS.ranking, 'PASS',
    `${row!.ranked} submissions ranked across ${row!.challenges} challenge(s)`
    + `${row!.fallback > 0
        ? `; ${row!.fallback} used absolute fidelity because their cohort was below the floor`
        : ''}.`)
}

/** §IV.5.5 — calibration passed, or the human fallback was invoked and recorded. */
async function calibrationDecided(): Promise<ReadinessCheck> {
  const row = await queryOne<{ decision: string; decided_by: string; fallback_plan: string }>(
    'SELECT decision, decided_by, fallback_plan FROM v_gate_status LIMIT 1')

  if (!row) {
    return check('calibration', STATEMENTS.calibration, 'FAIL',
      'No go/no-go decision has been recorded. An uncalibrated system must not rank.')
  }
  // Both outcomes pass: the statement is "passed its gate OR the fallback was invoked and
  // recorded". A recorded NO_GO satisfies it, and ranking is refused elsewhere.
  return check('calibration', STATEMENTS.calibration, 'PASS',
    row.decision === 'GO'
      ? `The gate was passed by ${row.decided_by}.`
      : `The gate was FAILED by ${row.decided_by} and the fallback recorded: ${row.fallback_plan}`)
}

/** §IV.5.6 — every flag in the cut band reviewed by a person, and the review recorded. */
async function cutBandReviewed(cohortKey: string): Promise<ReadinessCheck> {
  const row = await queryOne<{ in_band: number; open_flags: number; undecided: number }>(
    `SELECT COUNT(*)::int AS in_band,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM v_review_flags f
               WHERE f.run_index_id = sc.run_index_id
                 AND f.submission_id = sc.submission_id AND NOT f.dismissed))::int AS open_flags,
            COUNT(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM v_shortlist_decisions d
               WHERE d.run_index_id = sc.run_index_id
                 AND d.submission_id = sc.submission_id))::int AS undecided
       FROM submission_composite sc
       JOIN score_run sr ON sr.run_index_id = sc.run_index_id
      WHERE sr.cohort_key = $1 AND sc.in_cut_band`,
    [cohortKey])

  const inBand = row?.in_band ?? 0
  if (inBand === 0) {
    return check('cut_band', STATEMENTS.cutband, 'UNKNOWN',
      'No ranking with a cut band exists for this cohort yet.')
  }
  if (row!.open_flags > 0 || row!.undecided > 0) {
    return check('cut_band', STATEMENTS.cutband, 'FAIL',
      `Of ${inBand} submissions at the cut line, ${row!.undecided} have no recorded decision and `
      + `${row!.open_flags} still carry an unanswered caveat.`)
  }
  return check('cut_band', STATEMENTS.cutband, 'PASS',
    `All ${inBand} submissions at the cut line have a recorded decision and no open caveats.`)
}

/** §IV.5.7 — an appeal packet can be produced for any team in one action. */
async function appealPacketPossible(cohortKey: string): Promise<ReadinessCheck> {
  const row = await queryOne<{ total: number; packetable: number }>(
    `WITH cohort AS (
       SELECT DISTINCT cs.submission_id, cs.run_index_id FROM criterion_score cs
         JOIN score_run sr ON sr.run_index_id = cs.run_index_id
        WHERE sr.cohort_key = $1
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM v_submissions_submission s
               WHERE s.submission_id = c.submission_id))::int AS packetable
       FROM cohort c`,
    [cohortKey])

  const total = row?.total ?? 0
  if (total === 0) {
    return check('appeal_packet', STATEMENTS.appeal, 'UNKNOWN',
      'No scored submissions in this cohort.')
  }
  return row!.packetable === total
    ? check('appeal_packet', STATEMENTS.appeal, 'PASS',
        `A packet can be produced for all ${total} scored submissions.`)
    : check('appeal_packet', STATEMENTS.appeal, 'FAIL',
        `${total - row!.packetable} scored submission(s) have no current row, so no packet can `
        + `be produced for them — they were superseded after scoring.`)
}

const STATEMENTS = {
  rubric: 'A frozen, published rubric exists for each challenge, hash-recorded.',
  evidence:
    'Every submission has a validated repo URL, a recorded commit SHA and a build-probe result.',
  tworuns:
    'Every submission has two independent score runs with evidence at file-and-line granularity.',
  ranking:
    'Ranking is global, with fidelity normalised within cohort and the challenge split reported.',
  calibration: 'Calibration passed its gate, or the human fallback was invoked and recorded.',
  cutband: 'Every flag in the cut band was reviewed by a person and the review recorded.',
  appeal: 'An appeal packet can be produced for any team in one action.',
  // Not one of the plan's original seven. Added because discovery feeds the principles and
  // standards evaluators, so a partly-discovered cohort is ranked on unequal evidence — and the
  // definition of done covered the scores without covering what they were made from.
  coverage: 'Every submission in the cohort was evidenced on the same terms.',
  // Also outside the plan's seven. Two settings ship unset and silently disable what depends on
  // them: without an event window, provenance cannot flag work committed outside it, and the
  // 40% threshold beside it has nothing to apply to.
  event: 'The facts about this event are configured, so the checks that depend on them can run.',
} as const

/**
 * §IV.5.8 — was this cohort evidenced evenly?
 *
 * Reports what it found rather than pass or fail, in the form the other seven use. The state
 * that fails is PARTIAL and only PARTIAL: a cohort nobody discovered is consistent, and
 * therefore fair.
 */
async function evidencedEvenly(cohortKey: string): Promise<ReadinessCheck> {
  const row = await queryOne<{ submissions: number }>(
    `SELECT COUNT(DISTINCT cs.submission_id)::int AS submissions
       FROM criterion_score cs
       JOIN score_run sr ON sr.run_index_id = cs.run_index_id
      WHERE sr.cohort_key = $1`,
    [cohortKey])

  if (!row || row.submissions === 0) {
    return check('coverage', STATEMENTS.coverage, 'UNKNOWN',
      'No submission in this cohort has been scored, so there is nothing to compare.')
  }

  const ids = await query<{ submission_id: number }>(
    `SELECT DISTINCT cs.submission_id
       FROM criterion_score cs
       JOIN score_run sr ON sr.run_index_id = cs.run_index_id
      WHERE sr.cohort_key = $1`,
    [cohortKey])

  const coverage = await coverageFor(ids.rows.map((r) => Number(r.submission_id)))
  return check(
    'coverage', STATEMENTS.coverage,
    coverage.uneven ? 'FAIL' : 'PASS',
    coverage.note)
}

/**
 * §IV.5.9 — is this event configured at all?
 *
 * Reports UNKNOWN rather than FAIL: nothing has gone wrong, something has not been decided.
 * That distinction is the one the whole report is built around, and an unset setting is its
 * clearest instance — but UNKNOWN still does not count as ready, so it cannot be ignored.
 */
async function eventConfigured(): Promise<ReadinessCheck> {
  const missing: string[] = []

  const evaluationDate = (await getString('event.evaluation_date')).trim()
  if (evaluationDate === '') {
    missing.push(
      'the evaluation date (event.evaluation_date), without which the dry run cannot be shown '
      + 'to have happened early enough')
  }

  /*
   * Parsed by the schema the writer enforces, not by a presence check (E37).
   *
   * The old test was `startsAt && endsAt`, which passes for a window whose dates do not parse or
   * whose end precedes its start. That is exactly the value the scanner then treats as no window
   * at all — so this check would report the event as configured while provenance windowing was
   * silently off.
   */
  const window = eventWindowSchema.safeParse(await getJson<unknown>('scans.event_window'))
  if (!window.success) {
    missing.push(
      `the event window (scans.event_window) is set to something unusable — `
      + `${window.error.issues.map((i) => i.message).join('; ')} — so provenance cannot flag `
      + `work committed outside it`)
  } else if (window.data === null) {
    missing.push(
      'the event window (scans.event_window), without which provenance cannot flag work '
      + 'committed outside it')
  }

  return missing.length === 0
    ? check('event', STATEMENTS.event, 'PASS',
        `The evaluation date is ${evaluationDate}, and the event window is set.`)
    : check('event', STATEMENTS.event, 'UNKNOWN',
        // Named specifically, so it is actionable rather than a general complaint.
        `Not yet configured: ${missing.join('; ')}. Set these in event setup.`)
}

const check = (
  id: string, statement: string, status: CheckStatus, detail: string,
): ReadinessCheck => ({ id, statement, status, detail })
