/**
 * Rolling criterion scores into dimension scores (E07-S01).
 *
 * The rule that carries the most weight here is the denominator rule:
 *
 *   `insufficient_evidence` and `SCORING_FAILED` are **excluded from the denominator**, and the
 *   affected dimension is marked PARTIAL — never silently treated as zero (acceptance 3).
 *
 * Treating an unscored criterion as zero would mark a team down for something nobody checked,
 * and would do it invisibly: the composite would look like every other composite.
 */
import { DIMENSIONS, type Dimension } from '@crucible/rubric'

/**
 * The only part of a criterion this maths needs.
 *
 * Stated structurally so that adopted principles and standards — which are weighted items in a
 * dimension but are not rubric criteria — can be aggregated by the same function rather than by
 * a second copy of the denominator rule. A second copy is how the two drift apart.
 */
export interface WeightedItem {
  criterionId: string
  dimension: Dimension
  weight: number
}

/** One criterion's contribution, as stored. */
export interface ScoreInput {
  criterionId: string
  dimension: Dimension
  /** 0–4, or null when a non-score applies. */
  rawScore: number | null
  nonScore: string | null
}

export type DataQuality = 'COMPLETE' | 'PARTIAL' | 'UNSCORED'

export interface DimensionScore {
  dimension: Dimension
  /** 0–100, or null when nothing in the dimension could be scored. */
  score: number | null
  dataQuality: DataQuality
  /** Criteria that produced a score, and the weight they represent. */
  scoredCount: number
  totalCount: number
  /** Share of the dimension's weight that was actually scoreable, 0–1. */
  weightCovered: number
  /**
   * The weight the dimension's criteria carry in total, scored or not.
   *
   * Carried so that coverage can be computed one level up. Without it, two composites built over
   * different amounts of the rubric look identical, and the one missing a criterion the entry
   * would have done badly on looks BETTER — which is how an entry scored a perfect 100 on the
   * calibration set while a criterion it failed quietly vanished.
   */
  weightTotal: number
  excluded: Array<{ criterionId: string; reason: string }>
}

/**
 * The single documented transform from the 0–4 scale to 0–100 (acceptance 2).
 *
 * Linear, and stated once. A non-linear curve would be a policy decision about how much better a
 * 4 is than a 3, and that decision belongs to the committee's weights, not to a hidden formula.
 */
export function toHundred(rawScore: number): number {
  return (rawScore / 4) * 100
}


/**
 * Aggregate one dimension.
 *
 * Weights are renormalised across the criteria that *were* scored, so a dimension where one of
 * four criteria was unscoreable is scored out of the remaining three rather than out of four.
 */
export function aggregateDimension(
  dimension: Dimension,
  criteria: readonly WeightedItem[],
  scores: readonly ScoreInput[],
): DimensionScore {
  const inDimension = criteria.filter((c) => c.dimension === dimension)
  const byCriterion = new Map(scores.map((s) => [s.criterionId, s]))

  const excluded: DimensionScore['excluded'] = []
  let weightedTotal = 0
  let weightCovered = 0
  let scoredCount = 0
  const weightTotal = inDimension.reduce((n, c) => n + c.weight, 0)

  for (const criterion of inDimension) {
    const score = byCriterion.get(criterion.criterionId)

    if (!score || score.rawScore === null) {
      excluded.push({
        criterionId: criterion.criterionId,
        reason: score?.nonScore ?? 'NOT_SCORED',
      })
      continue
    }
    weightedTotal += toHundred(score.rawScore) * criterion.weight
    weightCovered += criterion.weight
    scoredCount++
  }

  if (inDimension.length === 0) {
    return {
      dimension, score: null, dataQuality: 'UNSCORED',
      scoredCount: 0, totalCount: 0, weightCovered: 0, weightTotal: 0, excluded: [],
    }
  }
  if (weightCovered === 0) {
    // Nothing in this dimension could be scored. Null, not zero: the difference is the whole
    // point of acceptance 3.
    return {
      dimension, score: null, dataQuality: 'UNSCORED',
      scoredCount: 0, totalCount: inDimension.length, weightCovered: 0,
      weightTotal: round(weightTotal), excluded,
    }
  }

  return {
    dimension,
    // Divided by the weight actually covered — the exclusion, made arithmetic.
    score: round(weightedTotal / weightCovered),
    dataQuality: excluded.length === 0 ? 'COMPLETE' : 'PARTIAL',
    scoredCount,
    totalCount: inDimension.length,
    weightCovered: round(weightCovered),
    weightTotal: round(weightTotal),
    excluded,
  }
}

export function aggregateAll(
  criteria: readonly WeightedItem[], scores: readonly ScoreInput[],
): DimensionScore[] {
  return DIMENSIONS.map((d) => aggregateDimension(d, criteria, scores))
}

export const round = (n: number): number => Math.round(n * 1e6) / 1e6
