/**
 * Estimates and the cost ceiling (E10-S02 acceptance 3, E10-S03).
 *
 * The rule under test everywhere here: an estimate is either measured or absent. An operator
 * plans around a finish time — they go to bed on it — so these tests are mostly about the cases
 * where the honest answer is "not yet known".
 */
import { describe, expect, it } from 'vitest'
import {
  ceilingVerdict, estimatedFinish, median, projectedCost, remainingMs,
} from './batchEstimate.js'

describe('median', () => {
  it('resists the outlier a mean would not', () => {
    // One enormous repository must not push the estimate out for the other forty-nine.
    expect(median([100, 110, 120, 130, 40_000])).toBe(120)
  })

  it('averages the two middles for an even count', () => {
    expect(median([10, 20, 30, 40])).toBe(25)
  })

  it('is null for no samples, never zero', () => {
    expect(median([])).toBeNull()
  })
})

describe('remaining wall-clock (E10-S02 acceptance 3)', () => {
  it('divides the work by the number of lanes', () => {
    // Ten submissions at 1s each, four at a time: 3s, not 10s.
    expect(remainingMs({ samples: [1000], remaining: 10, concurrency: 4 })).toBe(2500)
  })

  it('is null when NOTHING has been measured', () => {
    expect(remainingMs({ samples: [], remaining: 10, concurrency: 2 })).toBeNull()
  })

  it('is zero when there is nothing left, not null', () => {
    // "Measured, and none remaining" is a different statement from "unknown".
    expect(remainingMs({ samples: [500], remaining: 0, concurrency: 2 })).toBe(0)
  })

  it('treats a concurrency of zero as one rather than dividing by zero', () => {
    expect(remainingMs({ samples: [100], remaining: 4, concurrency: 0 })).toBe(400)
  })
})

describe('estimated finish', () => {
  const now = new Date('2026-03-01T00:00:00.000Z')

  it('sums the stages', () => {
    const finish = estimatedFinish(now, [
      { samples: [1000], remaining: 4, concurrency: 2 },
      { samples: [3000], remaining: 4, concurrency: 2 },
    ])
    expect(finish?.toISOString()).toBe('2026-03-01T00:00:08.000Z')
  })

  it('REFUSES to estimate when any stage is unmeasured', () => {
    // A run that still has fifty repositories to probe cannot be said to finish in the time
    // scoring alone would take.
    expect(estimatedFinish(now, [
      { samples: [1000], remaining: 4, concurrency: 2 },
      { samples: [], remaining: 50, concurrency: 2 },
    ])).toBeNull()
  })

  it('returns the present when there is no work left', () => {
    expect(estimatedFinish(now, [{ samples: [1000], remaining: 0, concurrency: 2 }]))
      .toEqual(now)
  })
})

describe('cost projection (E10-S03 acceptance 3)', () => {
  it('projects the total from what has been spent so far', () => {
    expect(projectedCost({
      costSoFarUsd: 5, completed: 10, total: 50, minimumSamples: 10,
    })).toBe(25)
  })

  it('REFUSES to project before the configured number of samples', () => {
    expect(projectedCost({
      costSoFarUsd: 0.5, completed: 1, total: 50, minimumSamples: 10,
    })).toBeNull()
  })

  it('refuses when nothing has completed', () => {
    expect(projectedCost({
      costSoFarUsd: 0, completed: 0, total: 50, minimumSamples: 0,
    })).toBeNull()
  })

  it('projects the spend so far when everything is done', () => {
    expect(projectedCost({
      costSoFarUsd: 30, completed: 50, total: 50, minimumSamples: 10,
    })).toBe(30)
  })
})

describe('the cost ceiling (E10-S03 acceptance 2)', () => {
  it('continues while spend and projection are both under it', () => {
    expect(ceilingVerdict({ costSoFarUsd: 10, projectedUsd: 50, ceilingUsd: 250 }))
      .toEqual({ action: 'CONTINUE' })
  })

  it('PAUSES once actual spend reaches the ceiling', () => {
    const verdict = ceilingVerdict({ costSoFarUsd: 250, projectedUsd: null, ceilingUsd: 250 })
    expect(verdict.action).toBe('PAUSE')
  })

  it('PAUSES on a projection that crosses it, before the money is gone', () => {
    // The useful case: stop while an operator can still raise the ceiling or cut the cohort.
    const verdict = ceilingVerdict({ costSoFarUsd: 40, projectedUsd: 400, ceilingUsd: 250 })
    expect(verdict.action).toBe('PAUSE')
    expect(verdict.action === 'PAUSE' && verdict.reason).toMatch(/would cost about \$400\.00/)
  })

  it('says the run is PAUSED, not cancelled, and that work is kept', () => {
    const verdict = ceilingVerdict({ costSoFarUsd: 300, projectedUsd: null, ceilingUsd: 250 })
    expect(verdict.action === 'PAUSE' && verdict.reason).toMatch(/paused rather than cancelled/)
    expect(verdict.action === 'PAUSE' && verdict.reason).toMatch(/already done is kept/)
  })

  it('does not pause on a projection that is merely close', () => {
    expect(ceilingVerdict({ costSoFarUsd: 40, projectedUsd: 250, ceilingUsd: 250 }))
      .toEqual({ action: 'CONTINUE' })
  })

  it('continues when no projection is available yet', () => {
    expect(ceilingVerdict({ costSoFarUsd: 1, projectedUsd: null, ceilingUsd: 250 }))
      .toEqual({ action: 'CONTINUE' })
  })
})
