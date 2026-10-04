/**
 * The principles-and-standards dimension (E06-S03).
 *
 * This dimension has two possible sources of judgement and the maths has to say plainly how
 * they combine, because the story gives it 20% of the composite and "the 20% they carry is
 * earned" is only true if the arithmetic is defensible:
 *
 *   - Rubric criteria the committee wrote in this dimension, each with its own weight.
 *   - Principles and standards the committee ADOPTED (E06-S03 acceptance 4, OD-2), each
 *     contributing equally, because nothing in the adopted list carries a weight.
 *
 * The two sub-scores are blended by an explicit split. When one side is empty the other takes
 * the whole dimension — which is the ordinary case at launch, where a committee has adopted
 * principles but written no rubric criteria in this dimension, or the reverse.
 *
 * When BOTH are empty the dimension is UNSCORED, not zero. A committee that has adopted no
 * principles has not thereby decided every team fails them; E07-S01 drops the dimension from
 * the denominator and the composite is marked partial.
 */
import type { Dimension } from '@crucible/rubric'
import { aggregateDimension, round, type DimensionScore, type ScoreInput } from './aggregate.js'

export const PRINCIPLES_DIMENSION: Dimension = 'PRINCIPLES_STANDARDS'

export type Compliance = 'COMPLIANT' | 'PARTIAL' | 'NON_COMPLIANT' | 'NOT_APPLICABLE'

export interface PrincipleOutcome {
  principleId: string
  maturity: number | null
  nonScore: string | null
}

export interface StandardOutcome {
  standardId: string
  compliance: Compliance | null
  nonScore: string | null
}

/**
 * A standard is a switch; the dimension is a scale. This is the conversion, stated once.
 *
 * PARTIAL sits at 2 rather than at 3 deliberately: partial compliance with a standard the
 * organisation requires is closer to the middle than to the top, and a team should not be able
 * to reach the upper anchors without actually meeting it.
 */
export const COMPLIANCE_SCALE: Record<Exclude<Compliance, 'NOT_APPLICABLE'>, number> = {
  COMPLIANT: 4,
  PARTIAL: 2,
  NON_COMPLIANT: 0,
}

/**
 * NOT_APPLICABLE is excluded rather than scored.
 *
 * A licence standard cannot be met by a repository with nothing to license, and marking that
 * down would penalise a team for the shape of their problem rather than their work.
 */
export function standardsAsScores(standards: readonly StandardOutcome[]): ScoreInput[] {
  return standards.map((s) => ({
    criterionId: `standard:${s.standardId}`,
    dimension: PRINCIPLES_DIMENSION,
    rawScore: s.compliance && s.compliance !== 'NOT_APPLICABLE'
      ? COMPLIANCE_SCALE[s.compliance]
      : null,
    nonScore: s.compliance === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : s.nonScore,
  }))
}

export function principlesAsScores(principles: readonly PrincipleOutcome[]): ScoreInput[] {
  return principles.map((p) => ({
    criterionId: `principle:${p.principleId}`,
    dimension: PRINCIPLES_DIMENSION,
    rawScore: p.maturity,
    nonScore: p.nonScore,
  }))
}

export interface PrinciplesDimensionInput {
  /** Rubric criteria the committee wrote in this dimension, with their declared weights. */
  criteria: ReadonlyArray<{ criterionId: string; weight: number }>
  criterionScores: readonly ScoreInput[]
  principles: readonly PrincipleOutcome[]
  standards: readonly StandardOutcome[]
  /**
   * Share of the dimension carried by rubric criteria when both sources are present.
   * 0.5 gives each half. Ignored when either side is empty.
   */
  rubricSplit: number
}

export interface PrinciplesDimensionScore extends DimensionScore {
  /** Reported so a reviewer can see which half produced the number (P5.1). */
  rubricScore: number | null
  adoptedScore: number | null
  /** The split actually applied, after the empty-side rules. */
  appliedSplit: number
  adoptedCount: number
}

export function principlesStandardsDimension(
  input: PrinciplesDimensionInput,
): PrinciplesDimensionScore {
  const rubricSide = aggregateDimension(
    PRINCIPLES_DIMENSION,
    input.criteria.map((c) => ({
      criterionId: c.criterionId, dimension: PRINCIPLES_DIMENSION, weight: c.weight,
    })),
    input.criterionScores,
  )

  // Adopted principles and standards each count once. Equal weight is not a simplification:
  // nothing in the adopted list declares a weight, and inventing one would be the maths
  // deciding policy.
  const adopted = [
    ...principlesAsScores(input.principles),
    ...standardsAsScores(input.standards),
  ]
  const adoptedSide = aggregateDimension(
    PRINCIPLES_DIMENSION,
    adopted.map((s) => ({
      criterionId: s.criterionId, dimension: PRINCIPLES_DIMENSION, weight: 1 / (adopted.length || 1),
    })),
    adopted,
  )

  const haveRubric = rubricSide.score !== null
  const haveAdopted = adoptedSide.score !== null
  const appliedSplit = haveRubric && haveAdopted ? input.rubricSplit : haveRubric ? 1 : 0

  const score = haveRubric && haveAdopted
    ? round(rubricSide.score! * appliedSplit + adoptedSide.score! * (1 - appliedSplit))
    : haveRubric ? rubricSide.score
    : haveAdopted ? adoptedSide.score
    : null

  const scoredCount = rubricSide.scoredCount + adoptedSide.scoredCount
  const totalCount = rubricSide.totalCount + adoptedSide.totalCount

  /**
   * One weight figure from the two sides, by the split that produced the score.
   *
   * Written once because both coverage figures must be blended identically: two copies of this
   * expression are how `weightCovered` and `weightTotal` come to disagree about what a half
   * means, and their ratio is the number the whole coverage check rests on.
   */
  const blend = (fromRubric: number, fromAdopted: number): number => round(
    haveRubric && haveAdopted
      ? fromRubric * appliedSplit + fromAdopted * (1 - appliedSplit)
      : haveRubric ? fromRubric
      : haveAdopted ? fromAdopted
      : 0,
  )

  return {
    dimension: PRINCIPLES_DIMENSION,
    score,
    dataQuality: score === null
      ? 'UNSCORED'
      : scoredCount < totalCount ? 'PARTIAL' : 'COMPLETE',
    scoredCount,
    totalCount,
    // Weight coverage, blended by the same split that produced the score — so it means the
    // same thing here as on every other dimension. A count ratio would read as coverage but
    // measure something else, and it is the figure a reviewer uses to judge how much of the
    // dimension was actually evidenced.
    weightCovered: blend(rubricSide.weightCovered, adoptedSide.weightCovered),
    // Blended by the same split, for the same reason: coverage has to mean the same thing on
    // this dimension as on every other, or the one figure that makes two composites comparable
    // is measuring something different here.
    weightTotal: blend(rubricSide.weightTotal, adoptedSide.weightTotal),
    excluded: [...rubricSide.excluded, ...adoptedSide.excluded],
    rubricScore: rubricSide.score,
    adoptedScore: adoptedSide.score,
    appliedSplit,
    adoptedCount: adopted.length,
  }
}
