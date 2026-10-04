/**
 * Criterion coverage: the figure that says whether two composites are comparable (migration 108).
 *
 * A dimension averages over the weight it covered, so a criterion that could not be scored is
 * dropped from the denominator rather than counted as zero. That rule is right — scoring an
 * unmeasured criterion as zero would punish a team for our inability to measure it — but it means
 * the gap FAVOURS the entry that has one. These tests pin the arithmetic that makes the effect
 * visible, including the identity a reviewer is given: counting the unscored criteria as zero is
 * exactly `composite × coverage`.
 */
import { describe, expect, it } from 'vitest'
import { aggregateDimension } from './aggregate.js'
import { computeComposite } from './composite.js'
import { buildReviewFlags } from './reviewFlags.js'

const criterion = (id: string, weight: number) => ({
  criterionId: id, dimension: 'ENGINEERING_QUALITY' as const, weight,
})
const scored = (id: string, raw: number | null, nonScore?: string) => ({
  criterionId: id, rawScore: raw, ...(nonScore ? { nonScore } : {}),
})

describe('a dimension reports the weight it could have covered', () => {
  it('reports the full weight when everything scored', () => {
    const d = aggregateDimension('ENGINEERING_QUALITY',
      [criterion('a', 0.5), criterion('b', 0.5)],
      [scored('a', 4), scored('b', 2)])
    expect(d.weightCovered).toBe(1)
    expect(d.weightTotal).toBe(1)
    expect(d.score).toBe(75)
  })

  it('reports the gap when a criterion produced no score', () => {
    // The score is over the half that was scored; the dimension still knows it was asked about
    // a whole.
    const d = aggregateDimension('ENGINEERING_QUALITY',
      [criterion('a', 0.5), criterion('b', 0.5)],
      [scored('a', 4), scored('b', null, 'SCORING_FAILED')])
    expect(d.score).toBe(100)
    expect(d.weightCovered).toBe(0.5)
    expect(d.weightTotal).toBe(1)
    expect(d.dataQuality).toBe('PARTIAL')
  })
})

describe('the composite carries coverage across the whole rubric', () => {
  const compose = (dimensions: ReturnType<typeof aggregateDimension>[]) => computeComposite({
    submissionId: 1, challengeId: 1, dimensions, fidelity: null,
    weights: {
      ENGINEERING_QUALITY: 1, CHALLENGE_FIDELITY: 0, PRINCIPLES_STANDARDS: 0,
      RUNS: 0, ORIGINALITY: 0,
    },
  })

  it('is 1 when every criterion scored', () => {
    const d = aggregateDimension('ENGINEERING_QUALITY',
      [criterion('a', 0.5), criterion('b', 0.5)], [scored('a', 4), scored('b', 2)])
    expect(compose([d]).criterionCoverage).toBe(1)
  })

  it('falls to the share that scored, and composite × coverage is the score counting zeros', () => {
    // The identity the reviewer's caveat rests on. Here: 100 over half the weight, so counting
    // the lost criterion as zero gives 50 — which is exactly what the full-denominator average
    // would have been.
    const d = aggregateDimension('ENGINEERING_QUALITY',
      [criterion('a', 0.5), criterion('b', 0.5)],
      [scored('a', 4), scored('b', null, 'INSUFFICIENT_EVIDENCE')])
    const c = compose([d])

    expect(c.composite).toBe(100)
    expect(c.criterionCoverage).toBe(0.5)
    expect(c.composite * c.criterionCoverage).toBe(50)
  })

  it('counts weight lost across SEVERAL dimensions, not per dimension', () => {
    // An entry can lose one criterion in each of three dimensions and look complete in all of
    // them if coverage is only ever read one dimension at a time.
    const eng = aggregateDimension('ENGINEERING_QUALITY',
      [criterion('a', 0.5), criterion('b', 0.5)],
      [scored('a', 4), scored('b', null, 'SCORING_FAILED')])
    const runs = {
      ...aggregateDimension('RUNS', [], []),
      dimension: 'RUNS' as const, score: 100, weightCovered: 0.5, weightTotal: 1,
    }
    const c = computeComposite({
      submissionId: 1, challengeId: 1, dimensions: [eng, runs], fidelity: null,
      weights: {
        ENGINEERING_QUALITY: 0.5, RUNS: 0.5, CHALLENGE_FIDELITY: 0,
        PRINCIPLES_STANDARDS: 0, ORIGINALITY: 0,
      },
    })
    expect(c.criterionCoverage).toBe(0.5)
  })
})

describe('the caveat tells a reviewer what the gap is worth', () => {
  it('states the score counting the unscored criteria as zero', () => {
    const [flag] = buildReviewFlags({
      nonScores: { insufficient: 0, failed: 1, total: 14, coverage: 0.92, composite: 100 },
    })
    expect(flag!.code).toBe('INSUFFICIENT_EVIDENCE')
    expect(flag!.message).toMatch(/92% of the rubric's weight/)
    expect(flag!.message).toMatch(/would give 92 rather than 100/)
  })

  it('says nothing about the effect when coverage is complete', () => {
    // Reached when a criterion is missing entirely rather than non-scored; there is no gap to
    // quantify, and an invented one would be worse than silence.
    const [flag] = buildReviewFlags({
      nonScores: { insufficient: 1, failed: 0, total: 14, coverage: 1, composite: 80 },
    })
    // The base wording legitimately contains "rather than counted as zero"; what must be absent
    // is the quantified effect.
    expect(flag!.message).not.toMatch(/of the rubric's weight/)
    expect(flag!.message).not.toMatch(/would give/)
  })

  it('still raises the caveat when we cannot quantify it', () => {
    const [flag] = buildReviewFlags({ nonScores: { insufficient: 2, failed: 0, total: 14 } })
    expect(flag!.code).toBe('INSUFFICIENT_EVIDENCE')
    expect(flag!.message).toMatch(/2 of 14 criteria produced no score/)
  })
})
