/**
 * The caveat that is about the SHAPE of a composite rather than about the evidence behind it.
 *
 * Calibration found that a well-built entry for the wrong challenge scored 20 of 100 on fidelity
 * and still placed mid-table, and that no choice of dimension weights changes that: a weighted
 * mean always lets strength elsewhere compensate. The product's answer is to say so and leave the
 * decision to a person, which is what these tests pin.
 */
import { describe, expect, it } from 'vitest'
import { buildReviewFlags } from './reviewFlags.js'

describe('good work, wrong question (LOW_CHALLENGE_FIDELITY)', () => {
  const flagFor = (input: Parameters<typeof buildReviewFlags>[0]) =>
    buildReviewFlags(input).find((f) => f.code === 'LOW_CHALLENGE_FIDELITY')

  it('is raised when fidelity falls below the threshold', () => {
    const flag = flagFor({ fidelity: { score: 20, otherDimensionsMean: 88, threshold: 35 } })
    expect(flag?.severity).toBe('ATTENTION')
    expect(flag?.message).toContain('20 of 100 on challenge fidelity')
    expect(flag?.message).toContain('below the 35')
    // Both readings named, neither asserted: a weak entry for the RIGHT brief also lands here.
    expect(flag?.message).toContain('either answered a different question')
    expect(flag?.message).toContain('or addressed this one barely')
  })

  it('draws the contrast when the other dimensions are far better', () => {
    // The shape that matters: excellent engineering on the wrong problem.
    const flag = flagFor({ fidelity: { score: 20, otherDimensionsMean: 88, threshold: 35 } })
    expect(flag?.message).toContain('88 on average across the other dimensions')
    expect(flag?.message).toContain('work the brief did not ask for')
  })

  it('omits the contrast when the entry is simply weak everywhere', () => {
    // Nothing to explain here: a poor entry is poor, not misdirected.
    const flag = flagFor({ fidelity: { score: 20, otherDimensionsMean: 25, threshold: 35 } })
    expect(flag?.message).not.toContain('on average across the other dimensions')
  })

  it('says the composite offsets rather than overrides, and leaves the decision to a person', () => {
    const flag = flagFor({ fidelity: { score: 10, otherDimensionsMean: 90, threshold: 35 } })
    expect(flag?.message).toContain('weighted average')
    expect(flag?.message).toContain('decision for the committee')
    expect(flag?.message).toContain('which of those two it is')
  })

  it('is NOT raised at or above the threshold', () => {
    expect(flagFor({ fidelity: { score: 35, otherDimensionsMean: 90, threshold: 35 } })).toBeUndefined()
    expect(flagFor({ fidelity: { score: 53, otherDimensionsMean: 40, threshold: 35 } })).toBeUndefined()
  })

  it('is NOT raised when fidelity could not be scored at all', () => {
    // An unscored dimension is a different caveat; claiming low fidelity would be a false fact.
    expect(flagFor({ fidelity: { score: null, otherDimensionsMean: 90, threshold: 35 } })).toBeUndefined()
  })

  it('is absent when no fidelity figure was supplied', () => {
    expect(flagFor({})).toBeUndefined()
  })

  it('records the figures it judged on, so a reviewer can check the caveat itself', () => {
    const flag = flagFor({ fidelity: { score: 20.4, otherDimensionsMean: 88.2, threshold: 35 } })
    expect(flag?.detail).toEqual({ fidelity: 20.4, threshold: 35, otherDimensionsMean: 88.2 })
  })
})

describe('the sandbox stopped it, so the system judged whose fault it was (SANDBOX_BLOCKED)', () => {
  const flagFor = (input: Parameters<typeof buildReviewFlags>[0]) =>
    buildReviewFlags(input).find((f) => f.code === 'SANDBOX_BLOCKED')

  it('is ALWAYS raised, because a regex decided the blame and a person must be able to overrule it', () => {
    const flag = flagFor({
      probe: {
        outcome: 'SANDBOX_BLOCKED', runsGrade: 'BLOCKED_BY_SANDBOX',
        reason: 'It tried to reach the network. Evidence: getaddrinfo EAI_AGAIN',
      },
    })
    expect(flag?.severity).toBe('ATTENTION')
    expect(flag?.message).toContain('3 of 4')
    expect(flag?.message).toContain('getaddrinfo EAI_AGAIN')
    // Both directions, explicitly: the committee can raise it as well as lower it.
    expect(flag?.message).toMatch(/decide whether that is the right weight/)
  })

  it('is not raised for an entry that simply ran', () => {
    expect(flagFor({
      probe: { outcome: 'RUNS', runsGrade: 'RUNS', reason: 'Stayed up.' },
    })).toBeUndefined()
  })

  it('is not raised for an ordinary crash — that one needs no explaining', () => {
    expect(flagFor({
      probe: { outcome: 'BUILDS_ONLY', runsGrade: 'BUILDS_ONLY', reason: 'Exited at once.' },
    })).toBeUndefined()
  })

  it('does not displace the harness caveats, which mean something different', () => {
    const flags = buildReviewFlags({
      probe: { outcome: 'PROBE_ERROR', runsGrade: 'UNSUPPORTED', reason: 'no docker' },
    })
    expect(flags.map((f) => f.code)).toContain('PROBE_ERROR')
    expect(flags.map((f) => f.code)).not.toContain('SANDBOX_BLOCKED')
  })
})
