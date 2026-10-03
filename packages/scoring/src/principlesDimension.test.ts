/**
 * The principles-and-standards dimension (E06-S03).
 *
 * This dimension carries 20% of the composite and can be fed by two independent sources, so the
 * tests concentrate on the blend: what happens when one side is missing, when the committee has
 * adopted nothing, and when a standard does not apply.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE_SCALE, principlesStandardsDimension, principlesAsScores, standardsAsScores,
} from './principlesDimension.js'
import type { ScoreInput } from './aggregate.js'

const criterionScore = (id: string, raw: number | null, nonScore: string | null = null): ScoreInput =>
  ({ criterionId: id, dimension: 'PRINCIPLES_STANDARDS', rawScore: raw, nonScore })

const base = {
  criteria: [] as Array<{ criterionId: string; weight: number }>,
  criterionScores: [] as ScoreInput[],
  principles: [] as Array<{ principleId: string; maturity: number | null; nonScore: string | null }>,
  standards: [] as Array<{ standardId: string; compliance: 'COMPLIANT' | 'PARTIAL' | 'NON_COMPLIANT' | 'NOT_APPLICABLE' | null; nonScore: string | null }>,
  rubricSplit: 0.5,
}

describe('when the committee has adopted nothing (OD-2)', () => {
  it('is UNSCORED rather than zero', () => {
    const result = principlesStandardsDimension(base)
    expect(result.score).toBeNull()
    expect(result.dataQuality).toBe('UNSCORED')
    expect(result.adoptedCount).toBe(0)
  })

  it('does not claim coverage it does not have', () => {
    expect(principlesStandardsDimension(base).weightCovered).toBe(0)
  })
})

describe('adopted principles alone', () => {
  const input = {
    ...base,
    principles: [
      { principleId: '1', maturity: 4, nonScore: null },
      { principleId: '2', maturity: 2, nonScore: null },
    ],
  }

  it('takes the whole dimension when there are no rubric criteria', () => {
    const result = principlesStandardsDimension(input)
    expect(result.score).toBe(75) // (100 + 50) / 2
    expect(result.appliedSplit).toBe(0)
    expect(result.rubricScore).toBeNull()
  })

  it('weights every adopted principle equally', () => {
    const result = principlesStandardsDimension({
      ...base,
      principles: [
        { principleId: '1', maturity: 4, nonScore: null },
        { principleId: '2', maturity: 4, nonScore: null },
        { principleId: '3', maturity: 0, nonScore: null },
      ],
    })
    expect(result.score).toBeCloseTo(66.667, 2)
  })

  it('EXCLUDES an unassessed principle from the denominator', () => {
    const result = principlesStandardsDimension({
      ...base,
      principles: [
        { principleId: '1', maturity: 4, nonScore: null },
        { principleId: '2', maturity: null, nonScore: 'INSUFFICIENT_EVIDENCE' },
      ],
    })
    expect(result.score).toBe(100)
    expect(result.dataQuality).toBe('PARTIAL')
  })
})

describe('adopted standards', () => {
  it('maps each verdict onto the 0–4 scale once, in one place', () => {
    expect(COMPLIANCE_SCALE.COMPLIANT).toBe(4)
    expect(COMPLIANCE_SCALE.PARTIAL).toBe(2)
    expect(COMPLIANCE_SCALE.NON_COMPLIANT).toBe(0)
  })

  it('puts PARTIAL at the middle, not near the top', () => {
    const partial = principlesStandardsDimension({
      ...base, standards: [{ standardId: '1', compliance: 'PARTIAL', nonScore: null }],
    })
    expect(partial.score).toBe(50)
  })

  it('EXCLUDES a NOT_APPLICABLE standard rather than scoring it non-compliant', () => {
    const result = principlesStandardsDimension({
      ...base,
      standards: [
        { standardId: '1', compliance: 'COMPLIANT', nonScore: null },
        { standardId: '2', compliance: 'NOT_APPLICABLE', nonScore: null },
      ],
    })
    // Scored out of the one standard that applied, not out of two.
    expect(result.score).toBe(100)
    expect(result.excluded.map((e) => e.criterionId)).toEqual(['standard:2'])
  })

  it('converts NOT_APPLICABLE into an exclusion the aggregator understands', () => {
    const [score] = standardsAsScores([
      { standardId: '7', compliance: 'NOT_APPLICABLE', nonScore: null },
    ])
    expect(score?.rawScore).toBeNull()
    expect(score?.nonScore).toBe('NOT_APPLICABLE')
  })

  it('namespaces its ids so a principle and a standard cannot collide', () => {
    const p = principlesAsScores([{ principleId: '1', maturity: 2, nonScore: null }])
    const s = standardsAsScores([{ standardId: '1', compliance: 'COMPLIANT', nonScore: null }])
    expect(p[0]?.criterionId).not.toBe(s[0]?.criterionId)
  })
})

describe('blending rubric criteria with the adopted list', () => {
  const both = {
    ...base,
    criteria: [{ criterionId: 'c1', weight: 1 }],
    criterionScores: [criterionScore('c1', 4)],
    principles: [{ principleId: '1', maturity: 0, nonScore: null }],
  }

  it('splits the dimension by the configured share', () => {
    expect(principlesStandardsDimension({ ...both, rubricSplit: 0.5 }).score).toBe(50)
    expect(principlesStandardsDimension({ ...both, rubricSplit: 1 }).score).toBe(100)
    expect(principlesStandardsDimension({ ...both, rubricSplit: 0 }).score).toBe(0)
  })

  it('reports both sides, so a reviewer can see which produced the number', () => {
    const result = principlesStandardsDimension(both)
    expect(result.rubricScore).toBe(100)
    expect(result.adoptedScore).toBe(0)
  })

  it('IGNORES the split when one side is empty, rather than halving the score', () => {
    const rubricOnly = principlesStandardsDimension({
      ...base,
      criteria: [{ criterionId: 'c1', weight: 1 }],
      criterionScores: [criterionScore('c1', 4)],
      rubricSplit: 0.5,
    })
    // The bug this prevents: 100 × 0.5 = 50 for a submission that scored full marks.
    expect(rubricOnly.score).toBe(100)
    expect(rubricOnly.appliedSplit).toBe(1)
  })

  it('reports weight coverage as a weight, blended the same way as the score', () => {
    const result = principlesStandardsDimension({
      ...both,
      criteria: [{ criterionId: 'c1', weight: 0.5 }, { criterionId: 'c2', weight: 0.5 }],
      criterionScores: [criterionScore('c1', 4), criterionScore('c2', null, 'SCORING_FAILED')],
      rubricSplit: 0.5,
    })
    // Half the rubric weight was scoreable, all of the adopted side was: 0.5×0.5 + 0.5×1.
    expect(result.weightCovered).toBeCloseTo(0.75, 5)
  })

  it('is PARTIAL when either side left something unscored', () => {
    const result = principlesStandardsDimension({
      ...both,
      principles: [
        { principleId: '1', maturity: 2, nonScore: null },
        { principleId: '2', maturity: null, nonScore: 'SCORING_FAILED' },
      ],
    })
    expect(result.dataQuality).toBe('PARTIAL')
  })

  it('counts every item across both sides', () => {
    const result = principlesStandardsDimension({
      ...both,
      standards: [{ standardId: '1', compliance: 'COMPLIANT', nonScore: null }],
    })
    expect(result.totalCount).toBe(3) // one criterion, one principle, one standard
    expect(result.adoptedCount).toBe(2)
  })

  it('ignores criteria belonging to other dimensions', () => {
    const result = principlesStandardsDimension({
      ...both,
      criterionScores: [
        criterionScore('c1', 4),
        { criterionId: 'other', dimension: 'RUNS', rawScore: 0, nonScore: null },
      ],
    })
    expect(result.rubricScore).toBe(100)
  })
})
