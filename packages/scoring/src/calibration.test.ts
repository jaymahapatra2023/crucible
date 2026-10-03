/**
 * Calibration arithmetic (E11-S02).
 *
 * The go/no-go decision rests on these numbers, so the tests concentrate on the cases where a
 * coefficient would mislead: too few items, no variation, ties, and the case a single number
 * cannot express — right about most and badly wrong about one.
 */
import { describe, expect, it } from 'vitest'
import {
  averageRanks, dimensionAgreement, disagreements, spearman,
} from './calibration.js'

describe('average ranks', () => {
  it('ranks from one, best first', () => {
    expect(averageRanks([10, 20, 30])).toEqual([1, 2, 3])
  })

  it('AVERAGES tied values rather than ordering them arbitrarily', () => {
    // Two items a human could not separate stay equal; forcing an order would invent a
    // judgement they did not make.
    expect(averageRanks([10, 20, 20, 40])).toEqual([1, 2.5, 2.5, 4])
  })

  it('handles every value being equal', () => {
    expect(averageRanks([5, 5, 5])).toEqual([2, 2, 2])
  })

  it('handles an empty list', () => {
    expect(averageRanks([])).toEqual([])
  })
})

describe('Spearman correlation', () => {
  it('is +1 for identical orderings', () => {
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4]).rho).toBe(1)
  })

  it('is -1 for exactly reversed orderings', () => {
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1]).rho).toBe(-1)
  })

  it('is high but not perfect when two neighbours swap', () => {
    const { rho } = spearman([1, 2, 3, 4, 5], [1, 3, 2, 4, 5])
    expect(rho).toBeGreaterThan(0.8)
    expect(rho).toBeLessThan(1)
  })

  it('REFUSES to report a coefficient over two items', () => {
    // Two items always correlate ±1, whatever the rankings mean.
    const result = spearman([1, 2], [2, 1])
    expect(result.rho).toBeNull()
    expect(result.note).toMatch(/always \+1 or -1/)
  })

  it('REFUSES when one side ranks everything equally', () => {
    const result = spearman([1, 2, 3, 4], [5, 5, 5, 5])
    expect(result.rho).toBeNull()
    expect(result.note).toMatch(/no order to correlate/)
  })

  it('refuses mismatched lengths rather than comparing what it can', () => {
    expect(spearman([1, 2, 3], [1, 2]).rho).toBeNull()
  })

  it('ALWAYS reports the sample size alongside', () => {
    // ρ = 0.8 over eight items is a different statement from ρ = 0.8 over eighty.
    expect(spearman([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8]).n).toBe(8)
  })

  it('copes with ties on both sides', () => {
    const { rho } = spearman([1, 1, 3, 4], [1, 2, 2, 4])
    expect(rho).not.toBeNull()
    expect(rho!).toBeGreaterThan(0)
  })
})

describe('disagreements', () => {
  const human = [
    { entryId: 'a', rank: 1 }, { entryId: 'b', rank: 2 },
    { entryId: 'c', rank: 3 }, { entryId: 'd', rank: 4 },
  ]

  it('finds none when the orderings match', () => {
    const result = disagreements(human, human, 2)
    expect(result.every((d) => d.delta === 0)).toBe(true)
    expect(result.some((d) => d.material)).toBe(false)
  })

  it('marks a gap at or beyond the threshold as material', () => {
    const machine = [
      { entryId: 'a', rank: 1 }, { entryId: 'b', rank: 2 },
      { entryId: 'c', rank: 4 }, { entryId: 'd', rank: 3 },
    ]
    const result = disagreements(human, machine, 2)
    expect(result.find((d) => d.entryId === 'c')?.material).toBe(false)

    const worse = disagreements(human, [
      { entryId: 'a', rank: 4 }, { entryId: 'b', rank: 2 },
      { entryId: 'c', rank: 3 }, { entryId: 'd', rank: 1 },
    ], 2)
    expect(worse.find((d) => d.entryId === 'a')?.material).toBe(true)
  })

  it('signs the delta so the DIRECTION of the error is visible', () => {
    const machine = [{ entryId: 'a', rank: 5 }]
    const [result] = disagreements([{ entryId: 'a', rank: 1 }], machine, 2)
    // Positive: the machine ranked it worse than the human did.
    expect(result?.delta).toBe(4)
  })

  it('lists the LARGEST disagreement first', () => {
    const machine = [
      { entryId: 'a', rank: 2 }, { entryId: 'b', rank: 1 },
      { entryId: 'c', rank: 8 }, { entryId: 'd', rank: 4 },
    ]
    expect(disagreements(human, machine, 2)[0]?.entryId).toBe('c')
  })

  it('shows why a coefficient ALONE cannot decide the gate (acceptance 1)', () => {
    // Twenty repositories. The machine agrees with the human about nineteen of them and ranks
    // the single best one LAST — the worst error it could make.
    const items = Array.from({ length: 20 }, (_, i) => ({ entryId: String(i), rank: i + 1 }))
    const machine = items.map((e, i) => ({ entryId: e.entryId, rank: i === 0 ? 20 : i }))

    const { rho } = spearman(items.map((e) => e.rank), machine.map((m) => m.rank))

    // ρ lands around 0.71 — which would CLEAR a plausible gate of 0.70 while the system was
    // ranking the strongest submission dead last. That is the whole argument for requiring
    // every material disagreement beside the coefficient rather than instead of it.
    expect(rho!).toBeGreaterThan(0.7)
    expect(rho!).toBeLessThan(0.75)

    const material = disagreements(items, machine, 5).filter((d) => d.material)
    expect(material).toHaveLength(1)
    expect(material[0]?.entryId).toBe('0')
    expect(material[0]?.delta).toBe(19)
  })

  it('a small set makes one large move dominate the coefficient', () => {
    // The corollary, and the reason a calibration set of eight is read through its
    // disagreements: the same single error that leaves ρ at 0.71 over twenty items drags it
    // to a third over eight.
    const eight = Array.from({ length: 8 }, (_, i) => ({ entryId: String(i), rank: i + 1 }))
    const machine = eight.map((e, i) => ({ entryId: e.entryId, rank: i === 0 ? 8 : i }))

    const { rho } = spearman(eight.map((e) => e.rank), machine.map((m) => m.rank))
    expect(rho!).toBeLessThan(0.5)
  })

  it('ignores an entry the machine never ranked', () => {
    expect(disagreements(human, [{ entryId: 'a', rank: 1 }], 2)).toHaveLength(1)
  })
})

describe('which dimension disagrees most (acceptance 3)', () => {
  it('orders dimensions worst-agreeing first', () => {
    const humanRanks = [1, 2, 3, 4]
    const result = dimensionAgreement(humanRanks, {
      // Tracks the human ordering: best work scores highest.
      ENGINEERING_QUALITY: [90, 70, 50, 30],
      // Inverted: this dimension rates the human's worst as its best.
      ORIGINALITY: [30, 50, 70, 90],
    })

    expect(result[0]?.dimension).toBe('ORIGINALITY')
    expect(result[0]?.correlation.rho).toBe(-1)
    expect(result[1]?.correlation.rho).toBe(1)
  })

  it('does not invert the sign of a sound dimension', () => {
    // A high score should mean a good (low) rank; correlating score against rank directly
    // would report every well-behaved dimension as perfectly wrong.
    const result = dimensionAgreement([1, 2, 3], { RUNS: [100, 50, 0] })
    expect(result[0]?.correlation.rho).toBe(1)
  })

  it('reports a dimension it cannot correlate rather than dropping it', () => {
    const result = dimensionAgreement([1, 2, 3], { RUNS: [50, 50, 50] })
    expect(result[0]?.correlation.rho).toBeNull()
    expect(result[0]?.correlation.note).toMatch(/no order to correlate/)
  })
})
