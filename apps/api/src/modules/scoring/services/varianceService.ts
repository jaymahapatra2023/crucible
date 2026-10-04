/**
 * Comparing the two scoring runs (E06-S06).
 *
 * Each cohort is scored twice, independently, and this is where the two are held against each
 * other. The point is not to average them — averaging would hide exactly the thing worth
 * knowing. The point is that a submission the system cannot place consistently is a submission
 * a person should look at.
 *
 * Two flags, and they answer different questions:
 *
 *   - `straddles_cut`  — the two runs disagree about whether this submission is in or out.
 *     That is the one that matters most: it is a disagreement with a consequence.
 *   - `exceeds_threshold` — the two composites differ by more than the configured margin,
 *     wherever the submission sits. A submission ranked 45th in one run and 38th in the other
 *     is not borderline, but the instability says something about how well it was measured.
 */
import { compareRuns, type RankedSubmission } from '@crucible/scoring'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { getNumber } from '../../platform/services/configService.js'
import { comparePins, describeDrift, type RunPin } from '../../../lib/runScope.js'
import { selectRunsForCohort } from '../db/scoringDb.js'
import { selectRanking, type CompositeRow } from '../db/rankingDb.js'
import {
  dismissVariance, selectOpenFlags, selectVariance, upsertVariance,
  type VarianceFlagRow, type VarianceRow,
} from '../db/varianceDb.js'

const log = createLogger('scoring', 'varianceService')

export interface VarianceSummary {
  cohortKey: string
  compared: number
  straddling: number
  exceeding: number
  /**
   * Whether the two runs were executed under the same settings (E14-S03).
   *
   * False means a difference between them may reflect the configuration change rather than the
   * submissions — which is the opposite of what a variance flag is usually read as saying.
   */
  alike: boolean
  driftNote: string
  /** Present in one run but not the other — reported, never silently dropped. */
  unmatched: number[]
  cutLine: number
  threshold: number
}

/**
 * Compute and persist the comparison for a cohort.
 *
 * Refuses when both runs are not present. A "variance" computed from one run would be a column
 * of zeros that looks exactly like perfect agreement.
 *
 * Compares the STORED rankings rather than recomputing composites. The flags this produces sit
 * beside the ranking a reviewer is looking at, and two independently-derived answers to "what
 * rank is this" would eventually disagree — at which point neither the flag nor the ranking
 * could be trusted.
 */
export async function computeVariance(cohortKey: string): Promise<VarianceSummary> {
  const runs = await selectRunsForCohort(cohortKey)
  const runA = runs.find((r) => r.run_index === 1)
  const runB = runs.find((r) => r.run_index === 2)

  if (!runA || !runB) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Cohort '${cohortKey}' has ${runs.length} scoring run(s). Variance needs both run 1 and ` +
        `run 2 — a comparison against a missing run would report perfect agreement.`,
    )
  }

  const [rankingA, rankingB] = await Promise.all([
    selectRanking(runA.run_index_id),
    selectRanking(runB.run_index_id),
  ])

  for (const [run, ranking] of [[runA, rankingA], [runB, rankingB]] as const) {
    if (ranking.length === 0) {
      throw new AppError(
        'PRECONDITION_FAILED',
        `Run ${run.run_index} of cohort '${cohortKey}' has no stored ranking. Compute the ` +
          `ranking for both runs before comparing them — otherwise the flags would describe an ` +
          `ordering nobody has seen.`,
      )
    }
  }

  // Before anything is compared: were these two runs even alike? A variance flag reads as
  // model instability, and if the settings moved between the runs it is measuring the settings.
  const drift = comparePins(
    (runA.pinned_config ?? null) as RunPin | null,
    (runB.pinned_config ?? null) as RunPin | null)
  if (!drift.alike) {
    log.warn('variance compared two runs that were not executed alike', {
      cohortKey, differences: drift.differences.map((d) => d.key),
    })
  }

  const cutLine = await getNumber('scoring.cut_line')
  const threshold = await getNumber('scoring.variance_delta_threshold')

  const results = compareRuns({
    runA: rankingA.map(asRanked), runB: rankingB.map(asRanked),
    cutLine, deltaThreshold: threshold,
  })

  for (const result of results) {
    await upsertVariance({
      cohortKey,
      submissionId: result.submissionId,
      runAId: runA.run_index_id,
      runBId: runB.run_index_id,
      compositeA: result.compositeA,
      compositeB: result.compositeB,
      delta: result.delta,
      rankA: result.rankA,
      rankB: result.rankB,
      straddlesCut: result.straddlesCut,
      exceedsThreshold: result.exceedsThreshold,
      thresholdUsed: threshold,
      cutLineUsed: cutLine,
    })
  }

  const summary: VarianceSummary = {
    cohortKey,
    compared: results.length,
    straddling: results.filter((r) => r.straddlesCut).length,
    exceeding: results.filter((r) => r.exceedsThreshold).length,
    unmatched: unmatchedSubmissions(rankingA.map(asRanked), rankingB.map(asRanked)),
    cutLine,
    threshold,
    alike: drift.alike,
    driftNote: describeDrift(drift),
  }

  if (summary.unmatched.length > 0) {
    // Not an error — a submission can legitimately be scored in one run and fail in the other —
    // but it is a coverage gap, and silence about it would read as agreement.
    log.warn('submissions appear in only one run and were not compared', {
      cohortKey, submissionIds: summary.unmatched,
    })
  }

  log.info('variance computed', { ...summary })
  return summary
}

function unmatchedSubmissions(
  runA: readonly RankedSubmission[], runB: readonly RankedSubmission[],
): number[] {
  const inB = new Set(runB.map((r) => r.submissionId))
  const inA = new Set(runA.map((r) => r.submissionId))
  return [
    ...runA.filter((r) => !inB.has(r.submissionId)).map((r) => r.submissionId),
    ...runB.filter((r) => !inA.has(r.submissionId)).map((r) => r.submissionId),
  ].sort((x, y) => x - y)
}

export async function listVariance(cohortKey: string): Promise<VarianceRow[]> {
  return selectVariance(cohortKey)
}

export async function listOpenFlags(cohortKey: string): Promise<VarianceFlagRow[]> {
  return selectOpenFlags(cohortKey)
}

/**
 * Dismiss a flag with a recorded reason (acceptance 5).
 *
 * The length rule is enforced by the database. This function adds the audit row, which is the
 * other half of "cannot be dismissed without a recorded reason": the reason must exist, and it
 * must be attributable.
 */
export async function dismissFlag(input: {
  cohortKey: string
  submissionId: number
  actor: string
  reason: string
}): Promise<VarianceRow> {
  let row: VarianceRow | null
  try {
    row = await dismissVariance(input.cohortKey, input.submissionId, input.actor, input.reason)
  } catch (err) {
    // The CHECK constraint refused it. Translated into something a reviewer can act on rather
    // than a raw constraint name.
    if (String(err).includes('chk_dismissal_has_reason')) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Dismissing a variance flag requires a reason of at least ten characters. The flag ' +
          'records that the system could not place this submission consistently; dismissing it ' +
          'without saying why leaves nothing for an appeal to answer.',
      )
    }
    throw err
  }

  if (!row) {
    throw new AppError(
      'NOT_FOUND',
      `No variance row for submission ${input.submissionId} in cohort '${input.cohortKey}'.`,
    )
  }

  await recordAudit({
    actor: input.actor,
    action: 'scoring.variance_flag_dismissed',
    subjectType: 'submission',
    subjectId: String(input.submissionId),
    payload: {
      cohortKey: input.cohortKey,
      reason: input.reason,
      delta: row.delta,
      straddlesCut: row.straddles_cut,
      exceedsThreshold: row.exceeds_threshold,
    },
  })

  return row
}

/**
 * A stored ranking row in the shape the comparison maths expects.
 *
 * `NUMERIC` columns arrive as numbers and the composite is already rounded, so this is a
 * renaming rather than a recomputation — which is the point: nothing here re-derives a position.
 */
function asRanked(row: CompositeRow): RankedSubmission {
  return {
    submissionId: row.submission_id,
    challengeId: row.challenge_id,
    composite: Number(row.composite),
    fidelityRaw: row.fidelity_raw === null ? null : Number(row.fidelity_raw),
    fidelityNormalised: row.fidelity_normalised === null ? null : Number(row.fidelity_normalised),
    cohortSize: row.cohort_size,
    normalisationMethod: row.normalisation_method as RankedSubmission['normalisationMethod'],
    missingDimensions: row.missing_dimensions as RankedSubmission['missingDimensions'],
    weightCovered: Number(row.weight_covered),
    criterionCoverage: Number(row.criterion_coverage),
    partial: row.partial,
    rankGlobal: row.rank_global,
    rankInChallenge: row.rank_in_challenge,
    tied: row.tied,
  }
}
