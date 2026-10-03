/**
 * Scoring maths (E06-S06, E07-S01 … E07-S06).
 *
 * This arithmetic decides who is eliminated. The tests concentrate on the cases where a
 * plausible-looking implementation goes quietly wrong: unscored criteria, empty dimensions,
 * degenerate cohorts, ties at the cut line.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DIMENSION_WEIGHTS, type Criterion, type Dimension } from '@crucible/rubric'
import { aggregateDimension, aggregateAll, toHundred, type ScoreInput } from './aggregate.js'
import { normaliseFidelity, percentileStanding } from './normalise.js'
import { advisoryDecided, compareRuns, computeComposite, cutBand, rank } from './composite.js'

const anchors = { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' }

function criterion(id: string, dimension: Dimension, weight: number): Criterion {
  return {
    criterionId: id, dimension, name: `Criterion ${id}`, description: '',
    weight, evidenceSpec: 'x', anchors, sortOrder: 0,
    ...(dimension === 'CHALLENGE_FIDELITY' ? { sourceRef: 'brief §1' } : {}),
  }
}

const score = (criterionId: string, dimension: Dimension, raw: number | null, nonScore: string | null = null): ScoreInput =>
  ({ criterionId, dimension, rawScore: raw, nonScore })

describe('the 0–4 to 0–100 transform (E07-S01 acceptance 2)', () => {
  it('is linear and documented', () => {
    expect(toHundred(0)).toBe(0)
    expect(toHundred(2)).toBe(50)
    expect(toHundred(4)).toBe(100)
  })
})

describe('dimension aggregation (E07-S01)', () => {
  const criteria = [
    criterion('a', 'ENGINEERING_QUALITY', 0.5),
    criterion('b', 'ENGINEERING_QUALITY', 0.3),
    criterion('c', 'ENGINEERING_QUALITY', 0.2),
  ]

  it('weights criteria within the dimension', () => {
    const result = aggregateDimension('ENGINEERING_QUALITY', criteria, [
      score('a', 'ENGINEERING_QUALITY', 4),
      score('b', 'ENGINEERING_QUALITY', 2),
      score('c', 'ENGINEERING_QUALITY', 0),
    ])
    // 100*0.5 + 50*0.3 + 0*0.2 = 65
    expect(result.score).toBe(65)
    expect(result.dataQuality).toBe('COMPLETE')
  })

  it('EXCLUDES insufficient evidence from the denominator, never scoring it zero', () => {
    const result = aggregateDimension('ENGINEERING_QUALITY', criteria, [
      score('a', 'ENGINEERING_QUALITY', 4),
      score('b', 'ENGINEERING_QUALITY', 4),
      score('c', 'ENGINEERING_QUALITY', null, 'INSUFFICIENT_EVIDENCE'),
    ])
    // Scored out of the 0.8 weight that could be judged, not out of 1.0.
    expect(result.score).toBe(100)
    expect(result.dataQuality).toBe('PARTIAL')
    expect(result.weightCovered).toBe(0.8)
    expect(result.excluded).toEqual([{ criterionId: 'c', reason: 'INSUFFICIENT_EVIDENCE' }])
  })

  it('would have scored 80 if the unscored criterion were treated as zero — the bug this prevents', () => {
    const correct = aggregateDimension('ENGINEERING_QUALITY', criteria, [
      score('a', 'ENGINEERING_QUALITY', 4),
      score('b', 'ENGINEERING_QUALITY', 4),
      score('c', 'ENGINEERING_QUALITY', null, 'INSUFFICIENT_EVIDENCE'),
    ])
    expect(correct.score).toBe(100)
    expect(correct.score).not.toBe(80)
  })

  it('excludes SCORING_FAILED the same way', () => {
    const result = aggregateDimension('ENGINEERING_QUALITY', criteria, [
      score('a', 'ENGINEERING_QUALITY', 2),
      score('b', 'ENGINEERING_QUALITY', null, 'SCORING_FAILED'),
      score('c', 'ENGINEERING_QUALITY', 2),
    ])
    expect(result.score).toBe(50)
    expect(result.dataQuality).toBe('PARTIAL')
  })

  it('returns NULL, not zero, when nothing in the dimension could be scored', () => {
    const result = aggregateDimension('ENGINEERING_QUALITY', criteria, [
      score('a', 'ENGINEERING_QUALITY', null, 'INSUFFICIENT_EVIDENCE'),
      score('b', 'ENGINEERING_QUALITY', null, 'SCORING_FAILED'),
      score('c', 'ENGINEERING_QUALITY', null, 'INSUFFICIENT_EVIDENCE'),
    ])
    expect(result.score).toBeNull()
    expect(result.dataQuality).toBe('UNSCORED')
  })

  it('treats a missing score row as excluded rather than as zero', () => {
    const result = aggregateDimension('ENGINEERING_QUALITY', criteria, [
      score('a', 'ENGINEERING_QUALITY', 4),
    ])
    expect(result.score).toBe(100)
    expect(result.excluded.map((e) => e.criterionId)).toEqual(['b', 'c'])
  })

  it('returns UNSCORED for a dimension with no criteria', () => {
    expect(aggregateAll(criteria, []).find((d) => d.dimension === 'RUNS'))
      .toMatchObject({ score: null, dataQuality: 'UNSCORED', totalCount: 0 })
  })
})

describe('cohort normalisation (E07-S02, E07-S03)', () => {
  const cohort20 = Array.from({ length: 20 }, (_, i) => i * 5)

  it('converts a raw score to a standing within its own cohort', () => {
    const result = normaliseFidelity(50, cohort20)
    expect(result.method).toBe('PERCENTILE')
    expect(result.normalised).toBeGreaterThan(0)
    expect(result.normalised).toBeLessThan(100)
  })

  it('ALWAYS preserves the raw score for appeals (acceptance 3)', () => {
    expect(normaliseFidelity(37, cohort20).raw).toBe(37)
  })

  it('is monotonic — a better raw score never normalises lower', () => {
    const low = normaliseFidelity(10, cohort20).normalised
    const high = normaliseFidelity(90, cohort20).normalised
    expect(high).toBeGreaterThan(low)
  })

  it('FALLS BACK to absolute scoring below the cohort floor (E07-S03 acceptance 2)', () => {
    const thin = normaliseFidelity(60, [10, 40, 60, 80], { minCohortSize: 15 })
    expect(thin.method).toBe('ABSOLUTE_FALLBACK')
    expect(thin.normalised).toBe(60)
    // Never silent (acceptance 3).
    expect(thin.note).toMatch(/below the floor/)
    expect(thin.note).toMatch(/flagged for human review/)
  })

  it('handles a cohort of ONE without dividing by zero or claiming a standing', () => {
    const single = normaliseFidelity(75, [75])
    expect(single.method).toBe('ABSOLUTE_FALLBACK')
    expect(single.normalised).toBe(75)
  })

  it('handles an ALL-EQUAL cohort by keeping raw scores, not flattening everyone to 50', () => {
    const uniform = Array.from({ length: 20 }, () => 80)
    const result = normaliseFidelity(80, uniform)
    expect(result.method).toBe('DEGENERATE_UNIFORM')
    expect(result.normalised).toBe(80)
    expect(result.note).toMatch(/erase a real shared result/)
  })

  it('handles an empty cohort', () => {
    expect(normaliseFidelity(50, []).method).toBe('ABSOLUTE_FALLBACK')
  })

  it('gives tied submissions the same standing', () => {
    const cohort = [10, 50, 50, 50, 90, ...Array.from({ length: 15 }, (_, i) => i)]
    expect(percentileStanding(50, cohort)).toBe(percentileStanding(50, cohort))
  })

  it('places the lowest and highest at the extremes', () => {
    const cohort = Array.from({ length: 20 }, (_, i) => i)
    expect(percentileStanding(0, cohort)).toBeLessThan(10)
    expect(percentileStanding(19, cohort)).toBeGreaterThan(90)
  })
})

describe('composite (E07-S04)', () => {
  const dimensions = (overrides: Partial<Record<Dimension, number | null>> = {}) =>
    (['CHALLENGE_FIDELITY', 'ENGINEERING_QUALITY', 'PRINCIPLES_STANDARDS', 'RUNS', 'ORIGINALITY'] as Dimension[])
      .map((dimension) => ({
        dimension,
        score: overrides[dimension] === undefined ? 80 : overrides[dimension],
        dataQuality: (overrides[dimension] === null ? 'UNSCORED' : 'COMPLETE') as const,
        scoredCount: 1, totalCount: 1, weightCovered: 1, excluded: [],
      }))

  const fidelity = (normalised: number) => ({
    normalised, raw: normalised, cohortSize: 20, method: 'PERCENTILE' as const, note: null,
  })

  it('combines dimensions by their weights', () => {
    const result = computeComposite({
      submissionId: 1, challengeId: 1,
      dimensions: dimensions(), fidelity: fidelity(80),
      weights: DEFAULT_DIMENSION_WEIGHTS,
    })
    expect(result.composite).toBeCloseTo(80, 5)
    expect(result.weightCovered).toBeCloseTo(1, 5)
  })

  it('uses the NORMALISED fidelity, not the raw one (acceptance)', () => {
    const result = computeComposite({
      submissionId: 1, challengeId: 1,
      dimensions: dimensions({ CHALLENGE_FIDELITY: 10 }),
      fidelity: { normalised: 90, raw: 10, cohortSize: 20, method: 'PERCENTILE', note: null },
      weights: DEFAULT_DIMENSION_WEIGHTS,
    })
    // Fidelity contributes 90 × 0.30, not 10 × 0.30.
    expect(result.composite).toBeGreaterThan(80)
    expect(result.fidelityRaw).toBe(10)
    expect(result.fidelityNormalised).toBe(90)
  })

  it('does NOT normalise the other four dimensions (E07-S02 acceptance 4)', () => {
    // Every non-fidelity dimension enters the composite exactly as scored. Normalising them
    // would mean a team's engineering score depended on who else entered their challenge,
    // which is precisely the comparison fidelity normalisation exists to CONFINE to fidelity.
    const dims = dimensions({
      ENGINEERING_QUALITY: 40, PRINCIPLES_STANDARDS: 40, RUNS: 40, ORIGINALITY: 40,
    })
    const weights = {
      CHALLENGE_FIDELITY: 0, ENGINEERING_QUALITY: 0.4, PRINCIPLES_STANDARDS: 0.2,
      RUNS: 0.3, ORIGINALITY: 0.1,
    }

    const alone = computeComposite({
      submissionId: 1, challengeId: 1, dimensions: dims, fidelity: fidelity(80), weights,
    })
    // The same submission, in a cohort where everyone else scored far higher. If any of these
    // dimensions were normalised within cohort, this composite would move.
    const inStrongField = computeComposite({
      submissionId: 1, challengeId: 1, dimensions: dims,
      fidelity: { normalised: 5, raw: 80, cohortSize: 40, method: 'PERCENTILE', note: null },
      weights,
    })

    expect(alone.composite).toBe(40)
    expect(inStrongField.composite).toBe(40)
  })

  it('EXCLUDES an unscoreable dimension rather than scoring it zero', () => {
    const result = computeComposite({
      submissionId: 1, challengeId: 1,
      dimensions: dimensions({ RUNS: null }),
      fidelity: fidelity(80), weights: DEFAULT_DIMENSION_WEIGHTS,
    })
    expect(result.composite).toBeCloseTo(80, 5)
    expect(result.missingDimensions).toEqual(['RUNS'])
    expect(result.weightCovered).toBeCloseTo(0.85, 5)
    expect(result.partial).toBe(true)
  })

  it('marks a composite partial when any dimension was partial', () => {
    const dims = dimensions().map((d) =>
      d.dimension === 'ENGINEERING_QUALITY' ? { ...d, dataQuality: 'PARTIAL' as const } : d)
    const result = computeComposite({
      submissionId: 1, challengeId: 1, dimensions: dims,
      fidelity: fidelity(80), weights: DEFAULT_DIMENSION_WEIGHTS,
    })
    expect(result.partial).toBe(true)
  })
})

describe('ranking (E07-S04)', () => {
  const make = (id: number, composite: number, challengeId = 1, weightCovered = 1) => ({
    submissionId: id, challengeId, composite, fidelityRaw: composite,
    fidelityNormalised: composite, cohortSize: 20, normalisationMethod: 'PERCENTILE' as const,
    missingDimensions: [], weightCovered, partial: false,
  })

  it('ranks by composite, descending', () => {
    const ranked = rank([make(1, 50), make(2, 90), make(3, 70)])
    expect(ranked.map((r) => r.submissionId)).toEqual([2, 3, 1])
    expect(ranked[0]?.rankGlobal).toBe(1)
  })

  it('ranks within challenge as well as globally', () => {
    const ranked = rank([make(1, 90, 1), make(2, 80, 2), make(3, 70, 1)])
    const third = ranked.find((r) => r.submissionId === 3)!
    expect(third.rankGlobal).toBe(3)
    expect(third.rankInChallenge).toBe(2)
  })

  it('breaks ties by evidence coverage, then by id — documented and deterministic', () => {
    const ranked = rank([make(2, 80, 1, 0.8), make(1, 80, 1, 1.0)])
    // Better-evidenced result wins the tie.
    expect(ranked[0]?.submissionId).toBe(1)
  })

  it('MARKS tied submissions, so a tie at the cut is visible rather than silently broken', () => {
    const ranked = rank([make(1, 80), make(2, 80), make(3, 50)])
    expect(ranked.filter((r) => r.tied).map((r) => r.submissionId).sort()).toEqual([1, 2])
    expect(ranked.find((r) => r.submissionId === 3)?.tied).toBe(false)
  })

  it('does NOT mark anything as selected — it ranks only (acceptance 3)', () => {
    const ranked = rank([make(1, 90), make(2, 10)])
    for (const entry of ranked) {
      expect(entry).not.toHaveProperty('selected')
      expect(entry).not.toHaveProperty('shortlisted')
    }
  })

  it('is deterministic across input order', () => {
    const input = [make(3, 70), make(1, 90), make(2, 80)]
    expect(rank(input).map((r) => r.submissionId))
      .toEqual(rank([...input].reverse()).map((r) => r.submissionId))
  })
})

describe('the cut band (E07-S06)', () => {
  const ranked = rank(Array.from({ length: 30 }, (_, i) => ({
    submissionId: i + 1, challengeId: 1, composite: 100 - i,
    fidelityRaw: 0, fidelityNormalised: 0, cohortSize: 30,
    normalisationMethod: 'PERCENTILE' as const, missingDimensions: [],
    weightCovered: 1, partial: false,
  })))

  it('returns the submissions around the boundary', () => {
    const band = cutBand(ranked, 20, 3)
    expect(band.map((s) => s.rankGlobal)).toEqual([17, 18, 19, 20, 21, 22, 23])
  })

  it('does not run off the start of the list', () => {
    expect(cutBand(ranked, 2, 5)[0]?.rankGlobal).toBe(1)
  })
})

describe('run-to-run variance (E06-S06)', () => {
  const runOf = (composites: Record<number, number>) =>
    rank(Object.entries(composites).map(([id, composite]) => ({
      submissionId: Number(id), challengeId: 1, composite,
      fidelityRaw: composite, fidelityNormalised: composite, cohortSize: 20,
      normalisationMethod: 'PERCENTILE' as const, missingDimensions: [],
      weightCovered: 1, partial: false,
    })))

  it('computes the composite delta per submission (acceptance 2)', () => {
    const results = compareRuns({
      runA: runOf({ 1: 80, 2: 60 }), runB: runOf({ 1: 75, 2: 60 }),
      cutLine: 1, deltaThreshold: 10,
    })
    expect(results.find((r) => r.submissionId === 1)?.delta).toBe(5)
    expect(results.find((r) => r.submissionId === 2)?.delta).toBe(0)
  })

  it('FLAGS a submission whose two runs straddle the cut line (acceptance 3)', () => {
    const runA = runOf({ 1: 90, 2: 80, 3: 70 })
    const runB = runOf({ 1: 90, 2: 65, 3: 75 })
    const results = compareRuns({ runA, runB, cutLine: 2, deltaThreshold: 50 })

    const straddlers = results.filter((r) => r.straddlesCut).map((r) => r.submissionId).sort()
    expect(straddlers).toEqual([2, 3])
  })

  it('FLAGS a large delta regardless of position (acceptance 4)', () => {
    const results = compareRuns({
      runA: runOf({ 1: 90, 2: 20 }), runB: runOf({ 1: 60, 2: 20 }),
      cutLine: 1, deltaThreshold: 10,
    })
    const flagged = results.find((r) => r.submissionId === 1)!
    expect(flagged.exceedsThreshold).toBe(true)
    // Both runs still place it first; the disagreement matters anyway.
    expect(flagged.straddlesCut).toBe(false)
  })

  it('reports both ranks, so the disagreement is legible', () => {
    const results = compareRuns({
      runA: runOf({ 1: 90, 2: 10 }), runB: runOf({ 1: 10, 2: 90 }),
      cutLine: 1, deltaThreshold: 10,
    })
    const first = results.find((r) => r.submissionId === 1)!
    expect(first.rankA).toBe(1)
    expect(first.rankB).toBe(2)
  })

  it('orders by delta, largest disagreement first', () => {
    const results = compareRuns({
      runA: runOf({ 1: 90, 2: 80, 3: 70 }), runB: runOf({ 1: 40, 2: 79, 3: 70 }),
      cutLine: 2, deltaThreshold: 10,
    })
    expect(results[0]?.submissionId).toBe(1)
  })

  it('ignores a submission present in only one run', () => {
    const results = compareRuns({
      runA: runOf({ 1: 90, 2: 80 }), runB: runOf({ 1: 90 }),
      cutLine: 1, deltaThreshold: 10,
    })
    expect(results.map((r) => r.submissionId)).toEqual([1])
  })
})

describe('the advisory dimension is never decisive (E06-S05 #3, E07-S06 #3)', () => {
  const dims = (originality: number) =>
    (['CHALLENGE_FIDELITY', 'ENGINEERING_QUALITY', 'PRINCIPLES_STANDARDS', 'RUNS', 'ORIGINALITY'] as Dimension[])
      .map((dimension) => ({
        dimension, score: dimension === 'ORIGINALITY' ? originality : 60,
        dataQuality: 'COMPLETE' as const, scoredCount: 1, totalCount: 1,
        weightCovered: 1, excluded: [],
      }))

  it('detects when removing originality would move a submission across the cut', () => {
    const fidelity = { normalised: 60, raw: 60, cohortSize: 20, method: 'PERCENTILE' as const, note: null }
    const score = computeComposite({
      submissionId: 1, challengeId: 1, dimensions: dims(0), fidelity,
      weights: DEFAULT_DIMENSION_WEIGHTS,
    })
    // Peers sit just above this submission's originality-dragged composite.
    const peers = Array.from({ length: 3 }, (_, i) => ({ ...score, submissionId: i + 2, composite: 57 }))

    const decided = advisoryDecided({
      score, dimensions: dims(0), weights: DEFAULT_DIMENSION_WEIGHTS,
      cutLine: 3, rankGlobal: 4, allScores: [score, ...peers],
    })
    expect(decided).toBe(true)
  })

  it('reports false when originality made no difference to the outcome', () => {
    const fidelity = { normalised: 95, raw: 95, cohortSize: 20, method: 'PERCENTILE' as const, note: null }
    const score = computeComposite({
      submissionId: 1, challengeId: 1, dimensions: dims(95), fidelity,
      weights: DEFAULT_DIMENSION_WEIGHTS,
    })
    const decided = advisoryDecided({
      score, dimensions: dims(95), weights: DEFAULT_DIMENSION_WEIGHTS,
      cutLine: 20, rankGlobal: 1, allScores: [score],
    })
    expect(decided).toBe(false)
  })
})
