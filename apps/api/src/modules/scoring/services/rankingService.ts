/**
 * Producing and storing the ranking (E07-S04, E07-S06).
 *
 * Ranking is an explicit operation whose result is written down, not a view computed on every
 * read. Both E07-S02 and E07-S04 say "stored", and they are right to: a ranking re-derived later
 * can hand an appeal a different number than the one the team was actually ranked by — the
 * cohort may have changed, the configuration may have been retuned — and nothing would record
 * which was shown at the time.
 *
 * The cost of storing is staleness, so staleness is made visible rather than ignored: the
 * snapshot records how many criterion scores the ranking was built from, and a ranking built
 * from fewer scores than the run now holds is reported as out of date.
 *
 * What this file deliberately does not do is select anyone. `in_cut_band` means "close enough to
 * the line that a person must look" (E07-S06 acceptance 2). Nothing here marks a submission as
 * chosen (P0 constraint 1, E07-S04 acceptance 3).
 */
import {
  advisoryDecided, cutBand, reviewReasons, REVIEW_REASON_TEXT,
  type RankedSubmission, type ReviewReason,
} from '@crucible/scoring'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { getNumber } from '../../platform/services/configService.js'
import type { DimensionWeights } from '@crucible/rubric'
import type { DimensionScore } from '@crucible/scoring'
import { frozenRubric } from '../../rubrics/services/rubricService.js'
import { compositesForRun } from './compositeService.js'
import { assertRankingPermitted } from '../../calibration/services/gateService.js'
import { selectScoreRun } from '../db/scoringDb.js'
import {
  countScores, replaceDimensionScores, replaceRanking, selectCutBand, selectRanking,
  selectRequiringReview, selectSnapshot,
  type CompositeInsert, type CompositeRow, type DimensionScoreInsert, type SnapshotRow,
} from '../db/rankingDb.js'
import { generateFlags } from '../../review/services/flagService.js'

const log = createLogger('scoring', 'rankingService')

export interface RankingResult {
  runIndexId: number
  ranked: ReviewableRow[]
  snapshot: SnapshotRow | null
  /** True when scores have been added since the ranking was computed. */
  stale: boolean
  /** Challenges whose cohort was too small to normalise (E07-S03). */
  fallbackChallenges: number[]
  cutLine: number
  bandSize: number
}

/** Compute the ranking for a run and store it, replacing any previous one. */
export async function computeRanking(
  runIndexId: number, actor: string,
): Promise<RankingResult> {
  // E11-S03 acceptance 3. An uncalibrated system, or one whose gate was failed, may gather
  // evidence but may not produce the ordering a shortlist is drawn from. Checked here rather
  // than at the route, so every caller — batch, script, future UI — is covered by one rule.
  await assertRankingPermitted()

  if (!(await selectScoreRun(runIndexId))) {
    throw new AppError('NOT_FOUND', `Scoring run ${runIndexId} was not found.`)
  }

  const [cutLine, bandSize, minCohortSize, coverageFloor] = await Promise.all([
    getNumber('scoring.cut_line'),
    getNumber('scoring.cut_band_size'),
    getNumber('scoring.min_cohort_size'),
    getNumber('scoring.min_criterion_coverage'),
  ])

  const { ranked, dimensions, fallbackChallenges } = await compositesForRun(runIndexId)

  if (ranked.length === 0) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Scoring run ${runIndexId} has no scored submissions to rank. Ranking an empty run would ` +
        `store a ranking that looks complete and contains nobody.`,
    )
  }

  const band = new Set(cutBand(ranked, cutLine, bandSize).map((r) => r.submissionId))
  const weights = await weightsByChallenge(ranked)
  const advisory = advisoryFlags(ranked, dimensions, weights, cutLine)

  const rows: CompositeInsert[] = ranked.map((entry) => ({
    reviewReasons: reviewReasons({
      entry,
      inCutBand: band.has(entry.submissionId),
      advisoryDecided: advisory.has(entry.submissionId),
      coverageFloor,
    }),
    submissionId: entry.submissionId,
    challengeId: entry.challengeId,
    composite: entry.composite,
    fidelityRaw: entry.fidelityRaw,
    fidelityNormalised: entry.fidelityNormalised,
    cohortSize: entry.cohortSize,
    normalisationMethod: entry.normalisationMethod,
    criterionCoverage: entry.criterionCoverage,
    rankGlobal: entry.rankGlobal,
    rankInChallenge: entry.rankInChallenge,
    tied: entry.tied,
    weightCovered: entry.weightCovered,
    missingDimensions: entry.missingDimensions,
    partial: entry.partial,
    inCutBand: band.has(entry.submissionId),
    advisoryDecided: advisory.has(entry.submissionId),
  }))

  // The breakdown behind each composite, written in the same pass so the two cannot disagree
  // about what produced the number (E08-S01 acceptance 1).
  await replaceDimensionScores(runIndexId, dimensionRows(ranked, dimensions, weights))

  await replaceRanking(runIndexId, rows, {
    scoresCounted: await countScores(runIndexId),
    submissions: rows.length,
    cutLineUsed: cutLine,
    bandSizeUsed: bandSize,
    minCohortSize,
    computedBy: actor,
  })

  // Every automated caveat, regenerated against this ranking (E08-S03). Flags belong to the
  // ranking a reviewer is looking at, so they are produced with it rather than on read.
  const run = await selectScoreRun(runIndexId)
  const flagCount = await generateFlags({
    runIndexId,
    cohortKey: run?.cohort_key ?? '',
    minCohortSize,
    subjects: ranked.map((entry) => ({
      submissionId: entry.submissionId,
      normalisationMethod: entry.normalisationMethod,
      cohortSize: entry.cohortSize,
      advisoryDecided: advisory.has(entry.submissionId),
      // Fidelity as it entered the composite, with the other dimensions' mean beside it, so the
      // caveat can draw the contrast that matters: good work, wrong question.
      challengeFidelity: entry.fidelityNormalised,
      otherDimensionsMean: meanOfOtherDimensions(dimensions.get(entry.submissionId) ?? []),
      // So the evidence caveat can state the EFFECT of what was not scored rather than only the
      // fact: counting the unscored criteria as zero is exactly composite × coverage.
      composite: entry.composite,
      criterionCoverage: entry.criterionCoverage,
    })),
  })

  await recordAudit({
    actor,
    action: 'scoring.ranking_computed',
    subjectType: 'score_run',
    subjectId: String(runIndexId),
    payload: {
      submissions: rows.length,
      requiresReview: rows.filter((r) => r.reviewReasons.length > 0).length,
      inCutBand: band.size,
      advisoryDecided: advisory.size,
      fallbackChallenges,
      cutLine,
      flagsRaised: flagCount,
    },
  })

  log.info('ranking computed', {
    runIndexId, submissions: rows.length, inCutBand: band.size,
    advisoryDecided: advisory.size,
    requiresReview: rows.filter((r) => r.reviewReasons.length > 0).length,
  })

  return storedRanking(runIndexId)
}

/** The dimension weights in force for every challenge this run covers, resolved once. */
async function weightsByChallenge(
  ranked: readonly RankedSubmission[],
): Promise<Map<number, DimensionWeights>> {
  const weights = new Map<number, DimensionWeights>()
  for (const challengeId of new Set(ranked.map((r) => r.challengeId))) {
    const rubric = await frozenRubric(challengeId)
    if (rubric) weights.set(challengeId, rubric.dimensionWeights)
  }
  return weights
}

/**
 * Submissions whose position depends on the advisory dimension (E07-S06 acceptance 3).
 *
 * Asked of every submission rather than only those in the band: a submission the advisory
 * dimension pushed *well* clear of the line is exactly as much a reporting problem as one it
 * pushed just under, and limiting the question to the band would hide the larger case.
 */
function advisoryFlags(
  ranked: readonly RankedSubmission[],
  dimensions: Map<number, DimensionScore[]>,
  weights: Map<number, DimensionWeights>,
  cutLine: number,
): Set<number> {
  const flagged = new Set<number>()

  for (const entry of ranked) {
    const dims = dimensions.get(entry.submissionId)
    const challengeWeights = weights.get(entry.challengeId)
    if (!dims || !challengeWeights) continue

    if (advisoryDecided({
      score: entry,
      dimensions: dims,
      weights: challengeWeights,
      cutLine,
      rankGlobal: entry.rankGlobal,
      allScores: ranked,
    })) {
      flagged.add(entry.submissionId)
    }
  }

  return flagged
}

/**
 * The five dimension scores behind each composite, with the weight each carried.
 *
 * The weight travels with the score because a reviewer's first question about a low dimension is
 * how much it actually moved the composite — and a 30-point dimension at 5% weight is a
 * different story from the same number at 30%.
 */
/** The mean of every scored dimension except fidelity. Null when none of them was scored. */
function meanOfOtherDimensions(dims: readonly DimensionScore[]): number | null {
  const scored = dims
    .filter((d) => d.dimension !== 'CHALLENGE_FIDELITY' && d.score !== null)
    .map((d) => d.score as number)
  if (scored.length === 0) return null
  return scored.reduce((a, b) => a + b, 0) / scored.length
}

function dimensionRows(
  ranked: readonly RankedSubmission[],
  dimensions: Map<number, DimensionScore[]>,
  weights: Map<number, DimensionWeights>,
): DimensionScoreInsert[] {
  const rows: DimensionScoreInsert[] = []

  for (const entry of ranked) {
    const dims = dimensions.get(entry.submissionId) ?? []
    const challengeWeights = weights.get(entry.challengeId)

    for (const dimension of dims) {
      rows.push({
        submissionId: entry.submissionId,
        dimension: dimension.dimension,
        // Fidelity is stored NORMALISED here, matching what entered the composite, with the
        // raw value kept on the composite row itself (E07-S02 acceptance 3).
        score: dimension.dimension === 'CHALLENGE_FIDELITY'
          ? entry.fidelityNormalised
          : dimension.score,
        dataQuality: dimension.dimension === 'CHALLENGE_FIDELITY' && entry.fidelityNormalised === null
          ? 'UNSCORED'
          : dimension.dataQuality,
        scoredCount: dimension.scoredCount,
        totalCount: dimension.totalCount,
        weightCovered: dimension.weightCovered,
        weight: challengeWeights?.[dimension.dimension] ?? 0,
        excluded: dimension.excluded,
      })
    }
  }

  return rows
}

/** The stored ranking, with whether it still reflects the scores in the run. */
export async function storedRanking(runIndexId: number): Promise<RankingResult> {
  const [ranked, snapshot, scoresNow] = await Promise.all([
    selectRanking(runIndexId),
    selectSnapshot(runIndexId),
    countScores(runIndexId),
  ])

  return {
    runIndexId,
    ranked: ranked.map(withReasonText),
    snapshot,
    stale: snapshot !== null && scoresNow !== snapshot.scores_counted,
    fallbackChallenges: [...new Set(
      ranked.filter((r) => r.normalisation_method === 'ABSOLUTE_FALLBACK')
        .map((r) => r.challenge_id),
    )].sort((a, b) => a - b),
    cutLine: snapshot?.cut_line_used ?? 0,
    bandSize: snapshot?.band_size_used ?? 0,
  }
}

/**
 * A ranking row with its review reasons spelled out.
 *
 * The plain text is added here rather than in the browser so the vocabulary has exactly one
 * definition (P1.5). The web app does not depend on the scoring package, and giving it a second
 * copy of the wording is how the two versions start disagreeing about what a flag means.
 */
export type ReviewableRow = CompositeRow & { review_reason_text: string[] }

export function withReasonText(row: CompositeRow): ReviewableRow {
  return {
    ...row,
    review_reason_text: row.review_reasons.map(
      (code) => REVIEW_REASON_TEXT[code as ReviewReason] ?? code),
  }
}

export interface CutBandReport {
  cutLine: number
  bandSize: number
  /** Every submission in the band — all of them require review (acceptance 2). */
  band: ReviewableRow[]
  /** Those whose position turns on the advisory dimension (acceptance 3). */
  advisoryDecided: ReviewableRow[]
  /** Ties spanning the cut line: the ordering between them is arbitrary and must not decide. */
  tiedAtCut: ReviewableRow[]
  /**
   * Everything flagged for review, INCLUDING submissions outside the band.
   *
   * A cohort too small to normalise is a caveat on a position wherever that position sits, and
   * limiting the review list to the band would quietly drop those (E07-S03 acceptance 2).
   */
  requiresReview: ReviewableRow[]
}

export async function cutBandReport(runIndexId: number): Promise<CutBandReport> {
  const snapshot = await selectSnapshot(runIndexId)
  if (!snapshot) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Scoring run ${runIndexId} has no stored ranking. Compute the ranking before asking which ` +
        `submissions sit near the cut line.`,
    )
  }

  const [bandRows, reviewRows] = await Promise.all([
    selectCutBand(runIndexId),
    selectRequiringReview(runIndexId),
  ])
  const band = bandRows.map(withReasonText)

  return {
    cutLine: snapshot.cut_line_used,
    bandSize: snapshot.band_size_used,
    band,
    advisoryDecided: band.filter((r) => r.advisory_decided),
    tiedAtCut: band.filter((r) => r.tied),
    requiresReview: reviewRows.map(withReasonText),
  }
}
