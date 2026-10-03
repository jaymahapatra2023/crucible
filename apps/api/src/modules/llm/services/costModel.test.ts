import { describe, expect, it } from 'vitest'
import { computeCost } from './costModel.js'

describe('cost attribution (P9.3, E01-S04 acceptance 4)', () => {
  const sonnet = { inputPerMTok: 3, outputPerMTok: 15 }

  it('prices input and output separately', () => {
    // 1M in at $3 + 1M out at $15
    expect(computeCost(sonnet, { tokensIn: 1_000_000, tokensOut: 1_000_000 })).toBeCloseTo(18, 6)
  })

  it('prices a realistic scoring call', () => {
    // 20k in, 1k out → 0.06 + 0.015
    expect(computeCost(sonnet, { tokensIn: 20_000, tokensOut: 1_000 })).toBeCloseTo(0.075, 6)
  })

  it('is zero for a call that used no tokens', () => {
    expect(computeCost(sonnet, { tokensIn: 0, tokensOut: 0 })).toBe(0)
  })

  it('rounds to six decimal places, so tiny calls still accrue rather than vanishing', () => {
    const cost = computeCost(sonnet, { tokensIn: 10, tokensOut: 1 })
    expect(cost).toBeGreaterThan(0)
    expect(String(cost).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6)
  })

  it('scales linearly, so a cohort projection from the first ten holds (E10-S03)', () => {
    const one = computeCost(sonnet, { tokensIn: 10_000, tokensOut: 500 })
    const fifty = computeCost(sonnet, { tokensIn: 500_000, tokensOut: 25_000 })
    expect(fifty).toBeCloseTo(one * 50, 5)
  })

  it('reflects a more expensive model', () => {
    const opus = { inputPerMTok: 15, outputPerMTok: 75 }
    const usage = { tokensIn: 100_000, tokensOut: 10_000 }
    expect(computeCost(opus, usage)).toBeGreaterThan(computeCost(sonnet, usage))
  })
})
