/**
 * Turning stored scores into composites and a ranking (E06-S06, E07-S01 … E07-S04).
 *
 * The arithmetic lives in `@crucible/scoring` and is tested on synthetic cohorts; this file is
 * the part that reads the database and applies the cohort rules. It is deliberately a read
 * operation: it computes and returns, and persists nothing. Ranking is recomputed from stored
 * scores rather than cached, so a criterion re-scored after a failure is reflected immediately
 * and no second copy of a team's position can go stale.
 *
 * The cohort is the CHALLENGE (E07-S02). Fidelity is a measure of answering the brief, and
 * briefs differ in difficulty; normalising against a pool of teams who answered a different
 * question would compare work that was never comparable.
 */
import {
  aggregateAll, computeComposite, normaliseFidelity, principlesStandardsDimension, rank,
  type CompositeScore, type DimensionScore, type RankedSubmission, type ScoreInput,
} from '@crucible/scoring'
import type { Criterion, Dimension, Rubric } from '@crucible/rubric'
import { createLogger } from '../../../lib/logger.js'
import { getNumber } from '../../platform/services/configService.js'
import { frozenRubric } from '../../rubrics/services/rubricService.js'
import {
  selectChallengeOf, selectRunDimensionInputs, selectScoredSubmissions,
} from '../db/scoringDb.js'
import {
  selectRunPrincipleOutcomes, selectRunStandardOutcomes,
} from '../db/principlesDb.js'
import { selectOriginalityLevels } from '../db/originalityDb.js'

const log = createLogger('scoring', 'compositeService')

export interface RunComposites {
  runIndexId: number
  ranked: RankedSubmission[]
  /** Per-submission dimension detail, for the review UI and the appeal packet. */
  dimensions: Map<number, DimensionScore[]>
  /** Challenges whose cohort was too small to normalise (E07-S03). */
  fallbackChallenges: number[]
}

export async function compositesForRun(runIndexId: number): Promise<RunComposites> {
  const submissionIds = await selectScoredSubmissions(runIndexId)
  if (submissionIds.length === 0) {
    return { runIndexId, ranked: [], dimensions: new Map(), fallbackChallenges: [] }
  }

  const [criterionRows, principleRows, standardRows, originalityRows, challengeOf] =
    await Promise.all([
      selectRunDimensionInputs(runIndexId),
      selectRunPrincipleOutcomes(runIndexId),
      selectRunStandardOutcomes(runIndexId),
      selectOriginalityLevels(runIndexId),
      selectChallengeOf(submissionIds),
    ])

  const rubricSplit = await getNumber('scoring.principles_rubric_split')
  const minCohortSize = await getNumber('scoring.min_cohort_size')

  const rubrics = await loadRubrics(challengeOf)

  // Two passes, and the split is not incidental: fidelity is normalised within its cohort
  // (E07-S02), so no submission's composite can be computed until every submission in its
  // challenge has a fidelity score.
  const { dimensions, fidelityByChallenge } = scoreDimensions({
    submissionIds, challengeOf, rubrics, rubricSplit,
    criterionRows, principleRows, standardRows, originalityRows,
  })

  const { composites, fallbackChallenges } = compose({
    dimensions, challengeOf, rubrics, fidelityByChallenge, minCohortSize,
  })

  return {
    runIndexId,
    ranked: rank(composites),
    dimensions,
    fallbackChallenges: [...fallbackChallenges].sort((a, b) => a - b),
  }
}

/** Pass one: dimension scores per submission, and the fidelity cohort for each challenge. */
function scoreDimensions(input: ScoreSources & {
  submissionIds: readonly number[]
  challengeOf: Map<number, number>
  rubrics: Map<number, Rubric>
}): {
  dimensions: Map<number, DimensionScore[]>
  fidelityByChallenge: Map<number, Map<number, number>>
} {
  const dimensions = new Map<number, DimensionScore[]>()
  const fidelityByChallenge = new Map<number, Map<number, number>>()

  for (const submissionId of input.submissionIds) {
    const challengeId = input.challengeOf.get(submissionId)
    const rubric = challengeId === undefined ? undefined : input.rubrics.get(challengeId)

    if (challengeId === undefined || !rubric) {
      // A score with no current submission row, or a challenge whose rubric is no longer frozen.
      // Ranking it would place a team by a standard the system cannot name.
      log.warn('submission skipped: no current submission row or no frozen rubric', {
        submissionId, challengeId,
      })
      continue
    }

    const scores = dimensionScoresFor({ ...input, submissionId, rubric })
    dimensions.set(submissionId, scores)

    const fidelity = scores.find((d) => d.dimension === 'CHALLENGE_FIDELITY')?.score
    if (fidelity !== null && fidelity !== undefined) {
      const forChallenge = fidelityByChallenge.get(challengeId) ?? new Map<number, number>()
      forChallenge.set(submissionId, fidelity)
      fidelityByChallenge.set(challengeId, forChallenge)
    }
  }

  return { dimensions, fidelityByChallenge }
}

/** Pass two: normalise fidelity within each challenge's cohort, then compose. */
function compose(input: {
  dimensions: Map<number, DimensionScore[]>
  challengeOf: Map<number, number>
  rubrics: Map<number, Rubric>
  fidelityByChallenge: Map<number, Map<number, number>>
  minCohortSize: number
}): { composites: CompositeScore[]; fallbackChallenges: Set<number> } {
  const composites: CompositeScore[] = []
  const fallbackChallenges = new Set<number>()

  for (const [submissionId, scores] of input.dimensions) {
    const challengeId = input.challengeOf.get(submissionId)!
    const rubric = input.rubrics.get(challengeId)!
    const forChallenge = input.fidelityByChallenge.get(challengeId)
    const raw = forChallenge?.get(submissionId)

    // A submission whose fidelity could not be scored is composed without it: E07-S01 drops the
    // dimension from the denominator rather than normalising a number that does not exist.
    const fidelity = raw === undefined
      ? null
      : normaliseFidelity(raw, [...(forChallenge?.values() ?? [])],
          { minCohortSize: input.minCohortSize })

    if (fidelity?.method === 'ABSOLUTE_FALLBACK') fallbackChallenges.add(challengeId)

    composites.push(computeComposite({
      submissionId,
      challengeId,
      dimensions: scores,
      fidelity,
      weights: rubric.dimensionWeights,
    }))
  }

  return { composites, fallbackChallenges }
}

async function loadRubrics(challengeOf: Map<number, number>): Promise<Map<number, Rubric>> {
  const rubrics = new Map<number, Rubric>()
  for (const challengeId of new Set(challengeOf.values())) {
    const rubric = await frozenRubric(challengeId)
    if (rubric) rubrics.set(challengeId, rubric)
  }
  return rubrics
}

/** Everything read once for the whole run, shared by every submission in it. */
interface ScoreSources {
  rubricSplit: number
  criterionRows: Awaited<ReturnType<typeof selectRunDimensionInputs>>
  principleRows: Awaited<ReturnType<typeof selectRunPrincipleOutcomes>>
  standardRows: Awaited<ReturnType<typeof selectRunStandardOutcomes>>
  originalityRows: Awaited<ReturnType<typeof selectOriginalityLevels>>
}

type DimensionInput = ScoreSources & {
  submissionId: number
  rubric: Rubric
}

/**
 * Dimension scores for one submission.
 *
 * Three of the five dimensions come straight from rubric criteria. PRINCIPLES_STANDARDS blends
 * criteria with the committee's adopted list, and ORIGINALITY comes from its own advisory
 * assessment — so both are computed here and REPLACE whatever the generic pass produced.
 */
function dimensionScoresFor(input: DimensionInput): DimensionScore[] {
  const { submissionId, rubric } = input

  const scores: ScoreInput[] = input.criterionRows
    .filter((r) => r.submissionId === submissionId)
    .map((r) => ({
      criterionId: String(r.criterionId),
      dimension: r.dimension as Dimension,
      rawScore: r.rawScore,
      nonScore: r.nonScore,
    }))

  const base = aggregateAll(rubric.criteria, scores)

  const principlesDimension = principlesStandardsDimension({
    criteria: rubric.criteria
      .filter((c: Criterion) => c.dimension === 'PRINCIPLES_STANDARDS')
      .map((c: Criterion) => ({ criterionId: c.criterionId, weight: c.weight })),
    criterionScores: scores,
    principles: input.principleRows
      .filter((r) => r.submissionId === submissionId)
      .map((r) => ({
        principleId: String(r.principleId), maturity: r.maturity, nonScore: r.nonScore,
      })),
    standards: input.standardRows
      .filter((r) => r.submissionId === submissionId)
      .map((r) => ({
        standardId: String(r.standardId),
        compliance: r.compliance as 'COMPLIANT' | 'PARTIAL' | 'NON_COMPLIANT' | 'NOT_APPLICABLE' | null,
        nonScore: r.nonScore,
      })),
    rubricSplit: input.rubricSplit,
  })

  const originality = input.originalityRows.find((r) => r.submissionId === submissionId)

  return base.map((dimension) => {
    if (dimension.dimension === 'PRINCIPLES_STANDARDS') return principlesDimension
    if (dimension.dimension === 'ORIGINALITY') return originalityDimension(dimension, originality)
    return dimension
  })
}

/**
 * The advisory dimension.
 *
 * A missing assessment — the flag was off, or the run predates it — leaves the dimension
 * UNSCORED. E07-S01 then drops it from the denominator and the composite is marked partial,
 * which is the honest reading of "we did not measure this".
 */
function originalityDimension(
  fallback: DimensionScore,
  row: { level: number | null; nonScore: string | null } | undefined,
): DimensionScore {
  if (!row) {
    return { ...fallback, score: null, dataQuality: 'UNSCORED', scoredCount: 0, totalCount: 0, weightCovered: 0 }
  }

  const scores: ScoreInput[] = [{
    criterionId: 'originality',
    dimension: 'ORIGINALITY',
    rawScore: row.level,
    nonScore: row.nonScore,
  }]
  const [only] = aggregateAll(
    [{ criterionId: 'originality', dimension: 'ORIGINALITY' as Dimension, weight: 1 }],
    scores,
  ).filter((d) => d.dimension === 'ORIGINALITY')
  return only ?? fallback
}
