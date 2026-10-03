/**
 * Orchestrating a scoring run over a cohort (E06-S06 acceptance 1, E10-S04).
 *
 * Two runs per cohort, `run_index` 1 and 2, each scoring every submission independently. They
 * are independent in the sense that matters: neither can see the other's scores, so run 2 cannot
 * anchor on run 1. They are NOT independent in model or prompt — both run at temperature 0
 * against the same frozen rubric, because the question the double run answers is "does this
 * system place this team consistently", and changing the model between runs would answer a
 * different question.
 *
 * Rubric versions are pinned at the start of the run (P4.4) and recorded on the run row, so a
 * rubric re-versioned mid-run cannot silently change the standard half a cohort was judged by.
 */
import type { Rubric } from '@crucible/rubric'
import { AppError, errorMessage } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { captureRunPin, getNumber, getString } from '../../platform/services/configService.js'
import { withRunPin, type RunPin } from '../../../lib/runScope.js'
import { frozenRubric } from '../../rubrics/services/rubricService.js'
import { scoreSubmission, type SubmissionScoreSummary } from './submissionScorer.js'
import {
  finishScoreRun, insertScoreRun, selectChallengeOf, selectRunsForCohort, selectScoreRun,
  type ScoreRunRow,
} from '../db/scoringDb.js'
import { recordCohorts } from '../db/rankingDb.js'

const log = createLogger('scoring', 'scoreRunService')

export interface StartRunInput {
  cohortKey: string
  runIndex: 1 | 2
  submissionIds: readonly number[]
  startedBy: string
  ledgerRunId?: number
  /** Skip criteria already scored in this run rather than re-scoring them (E10-S04). */
  resume?: boolean
}

export interface RunOutcome {
  run: ScoreRunRow
  summaries: SubmissionScoreSummary[]
  failedSubmissions: Array<{ submissionId: number; error: string }>
}

export async function startRun(input: StartRunInput): Promise<RunOutcome> {
  if (input.submissionIds.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'A scoring run needs at least one submission. An empty run would complete successfully ' +
        'and report nothing, which reads exactly like a cohort that scored badly.',
    )
  }

  const existing = (await selectRunsForCohort(input.cohortKey))
    .find((r) => r.run_index === input.runIndex)
  if (existing && !input.resume) {
    throw new AppError(
      'CONFLICT',
      `Cohort '${input.cohortKey}' already has run ${input.runIndex} (${existing.status}). ` +
        `Re-running it would replace scores a reviewer may already have seen — pass resume to ` +
        `continue it, or start the other run index.`,
    )
  }

  const rubrics = await pinRubrics(input.submissionIds)
  // Captured before the run exists, so nothing it does can influence what it was pinned to.
  const pin = await captureRunPin()
  const run = existing ?? await insertScoreRun({
    runIndex: input.runIndex,
    cohortKey: input.cohortKey,
    rubricVersions: Object.fromEntries(
      [...rubrics].map(([challengeId, rubric]) => [String(challengeId), rubric.version])),
    model: await getString('llm.default_model'),
    ledgerRunId: input.ledgerRunId ?? null,
    startedBy: input.startedBy,
    pinnedConfig: pin,
  })

  // BEFORE any scoring (E07-S03 acceptance 1). The cohort a submission was normalised against
  // is part of what its fidelity score means, so it is recorded as a fact about this run rather
  // than re-derived later from a database that has moved on.
  await recordRunCohorts(run.run_index_id, input.submissionIds)

  await recordAudit({
    actor: input.startedBy,
    action: existing ? 'scoring.run_resumed' : 'scoring.run_started',
    subjectType: 'score_run',
    subjectId: String(run.run_index_id),
    payload: {
      cohortKey: input.cohortKey,
      runIndex: input.runIndex,
      submissions: input.submissionIds.length,
      rubricVersions: run.rubric_versions,
    },
  })

  // Scored inside the pin (E14-S02). A resumed run re-enters the pin it was opened with, not a
  // fresh capture — otherwise the second half of a resumed cohort would be scored under
  // whatever the settings had become, which is the very thing the pin exists to prevent.
  const active = (run.pinned_config ?? pin) as RunPin
  const outcome = await withRunPin(active, () => scoreAll(run, input, rubrics))

  // A run where some submissions failed is COMPLETED, not FAILED: the scores that were produced
  // are real and the failures are recorded per submission. Marking the whole run failed would
  // throw away work and tell an operator less, not more.
  await finishScoreRun(
    run.run_index_id,
    outcome.summaries.length === 0 ? 'FAILED' : 'COMPLETED',
    outcome.failedSubmissions.length === 0
      ? null
      : `${outcome.failedSubmissions.length} submission(s) could not be scored.`,
  )

  log.info('scoring run finished', {
    runIndexId: run.run_index_id,
    cohortKey: input.cohortKey,
    runIndex: input.runIndex,
    scored: outcome.summaries.length,
    failed: outcome.failedSubmissions.length,
  })

  return { ...outcome, run: (await selectScoreRun(run.run_index_id)) ?? run }
}

async function scoreAll(
  run: ScoreRunRow, input: StartRunInput, rubrics: Map<number, Rubric>,
): Promise<Omit<RunOutcome, 'run'>> {
  const challengeOf = await selectChallengeOf(input.submissionIds)
  const summaries: SubmissionScoreSummary[] = []
  const failedSubmissions: Array<{ submissionId: number; error: string }> = []

  for (const submissionId of input.submissionIds) {
    const challengeId = challengeOf.get(submissionId)
    const rubric = challengeId === undefined ? undefined : rubrics.get(challengeId)

    if (!rubric) {
      failedSubmissions.push({
        submissionId,
        error: challengeId === undefined
          ? 'No current submission row — it may have been superseded since the run was planned.'
          : `Challenge ${challengeId} has no frozen rubric.`,
      })
      continue
    }

    try {
      summaries.push(await scoreSubmission({
        runIndexId: run.run_index_id,
        submissionId,
        rubric,
        ...(input.resume !== undefined && { resume: input.resume }),
        ...(input.ledgerRunId !== undefined && { ledgerRunId: input.ledgerRunId }),
      }))
    } catch (err) {
      // One submission's failure does not end the run. Forty-nine scored submissions are worth
      // more than a run abandoned at the tenth.
      log.error('submission could not be scored', { submissionId, err })
      failedSubmissions.push({ submissionId, error: errorMessage(err) })
    }
  }

  return { summaries, failedSubmissions }
}

/**
 * The frozen rubric for every challenge this cohort touches, resolved once.
 *
 * Refuses the whole run when any challenge lacks one, rather than scoring the submissions it
 * can: a cohort scored against a partial set of rubrics produces a ranking in which some teams
 * were judged and others were not, and the ranking does not say which.
 */
async function pinRubrics(submissionIds: readonly number[]): Promise<Map<number, Rubric>> {
  const challengeOf = await selectChallengeOf(submissionIds)
  const rubrics = new Map<number, Rubric>()
  const missing: number[] = []

  for (const challengeId of new Set(challengeOf.values())) {
    const rubric = await frozenRubric(challengeId)
    if (rubric) rubrics.set(challengeId, rubric)
    else missing.push(challengeId)
  }

  if (missing.length > 0) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `No frozen rubric for challenge(s) ${missing.join(', ')}. Freeze every rubric this cohort ` +
        `covers before scoring — a score must be able to name the exact standard it ran under.`,
    )
  }

  return rubrics
}

/**
 * Record how many submissions each challenge contributes to this run.
 *
 * Counted from the submissions the run was asked to score, not from the challenge's total: a
 * submission excluded from the run did not take part in the cohort, and counting it would claim
 * a normalisation base that was never used.
 */
async function recordRunCohorts(
  runIndexId: number, submissionIds: readonly number[],
): Promise<void> {
  const challengeOf = await selectChallengeOf(submissionIds)
  const floorUsed = await getNumber('scoring.min_cohort_size')

  const counts = new Map<number, number>()
  for (const challengeId of challengeOf.values()) {
    counts.set(challengeId, (counts.get(challengeId) ?? 0) + 1)
  }

  await recordCohorts(runIndexId, [...counts].map(([challengeId, cohortSize]) => ({
    challengeId, cohortSize, floorUsed,
  })))

  for (const [challengeId, cohortSize] of counts) {
    if (cohortSize < floorUsed) {
      // Said once, loudly, at the point the decision is made — not discovered later by someone
      // reading a ranking (E07-S03 acceptance 2).
      log.warn('cohort is below the normalisation floor; fidelity will not be normalised', {
        runIndexId, challengeId, cohortSize, floorUsed,
      })
    }
  }
}
