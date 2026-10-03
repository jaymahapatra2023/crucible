import { describe, expect, it, vi } from 'vitest'
import { backoffDelayMs, classify, isTransport, planFor } from './retryStrategy.js'
import { FAILURE_CLASSES } from '../types/llmTypes.js'
import { ProviderError } from '../providers/providerContract.js'

describe('classified retry (P4.2)', () => {
  it('halves the context after a too-short response', () => {
    expect(planFor('TOO_SHORT').contextScale).toBe(0.5)
  })

  it('adds a format instruction after a structural failure', () => {
    expect(planFor('BAD_STRUCTURE').reinforcement).toMatch(/structure|JSON/i)
  })

  it('adds a JSON-only constraint after a parse error', () => {
    expect(planFor('JSON_PARSE_ERROR').reinforcement).toMatch(/valid, complete JSON/i)
  })

  it('doubles the timeout and prefers a faster model after a timeout', () => {
    const plan = planFor('TIMEOUT')
    expect(plan.timeoutScale).toBe(2)
    expect(plan.preferFasterModel).toBe(true)
  })

  it('switches model after empty content', () => {
    expect(planFor('CONTENT_EMPTY').switchModel).toBe(true)
  })

  it('gives every failure class a distinct plan — no blind repeat', () => {
    // Derived from the declaration rather than hand-listed: a hand-listed set silently stops
    // covering classes added later, which is how a new class ends up sharing another's plan.
    const strategic = FAILURE_CLASSES.filter((c) => c !== 'RATE_LIMITED' && c !== 'PROVIDER_ERROR')
    const plans = strategic.map((c) => JSON.stringify(planFor(c)))
    expect(new Set(plans).size).toBe(strategic.length)
  })

  it('tells a model that cited something untrue exactly which rule it broke', () => {
    // "Be accurate" is not an instruction a model can act on. Naming the rule is.
    const plan = planFor('CITATION_UNVERIFIED')
    expect(plan.reinforcement).toMatch(/quoted verbatim|exact path/i)
    expect(plan.reinforcement).toMatch(/insufficient evidence/i)
  })

  it('does NOT shrink the context after an unverified citation', () => {
    // The opposite of TOO_SHORT: a model needs more of the source to cite it correctly, not
    // less. Sharing that plan would make the next attempt likelier to fail the same way.
    expect(planFor('CITATION_UNVERIFIED').contextScale).toBe(1)
  })

  it('returns a neutral plan for the first attempt', () => {
    const plan = planFor(null)
    expect(plan.reinforcement).toBe('')
    expect(plan.contextScale).toBe(1)
    expect(plan.timeoutScale).toBe(1)
  })
})

describe('classify', () => {
  it.each([
    ['TIMEOUT', 'TIMEOUT'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
    ['PROVIDER_ERROR', 'PROVIDER_ERROR'],
    ['UNAVAILABLE', 'PROVIDER_ERROR'],
  ] as const)('maps provider %s to %s', (kind, expected) => {
    expect(classify(new ProviderError(kind, 'x'))).toBe(expected)
  })

  it('treats an unknown throw as a provider error', () => {
    expect(classify(new Error('who knows'))).toBe('PROVIDER_ERROR')
  })
})

describe('backoff', () => {
  it('grows exponentially and is capped', () => {
    // Pinned rather than sampled: with a random draw, an assertion about the cap only fails on
    // the runs where the draw happens to exceed it — which is how a real change to the cap sat
    // in the suite as intermittent noise instead of a failure.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    try {
      expect(backoffDelayMs(3, 500)).toBeGreaterThan(backoffDelayMs(1, 500))
      expect(backoffDelayMs(20, 500)).toBeLessThanOrEqual(30_000)
    } finally {
      random.mockRestore()
    }
  })

  it('waits LONGER when the provider asked us to slow down (E10-S02 acceptance 2)', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    try {
      // A rate limit is the provider saying "slow down"; a generic 500 is not.
      expect(backoffDelayMs(2, 500, 4)).toBeGreaterThan(backoffDelayMs(2, 500, 1))
      // And still bounded, so one call cannot stall a batch for minutes.
      expect(backoffDelayMs(20, 500, 4)).toBeLessThanOrEqual(60_000)
    } finally {
      random.mockRestore()
    }
  })

  it('is jittered, so parallel workers do not re-collide on every retry', () => {
    const samples = new Set(Array.from({ length: 50 }, () => backoffDelayMs(4, 500)))
    expect(samples.size).toBeGreaterThan(5)
  })

  it('is never negative', () => {
    for (let a = 1; a <= 10; a++) expect(backoffDelayMs(a, 500)).toBeGreaterThanOrEqual(0)
  })
})

describe('isTransport', () => {
  it('identifies retry-without-changing-the-prompt failures', () => {
    expect(isTransport('TIMEOUT')).toBe(true)
    expect(isTransport('RATE_LIMITED')).toBe(true)
    expect(isTransport('SCHEMA_INVALID')).toBe(false)
  })
})
