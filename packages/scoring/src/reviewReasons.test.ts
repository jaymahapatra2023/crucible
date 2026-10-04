/**
 * Review flags (E07-S03 acceptance 2, E07-S06 acceptance 2).
 *
 * These decide who a person is told to look at. The failure mode worth guarding against is a
 * submission that quietly needs review and is not flagged — so most of these tests assert that
 * a reason IS produced, and the ordering test protects the case where a truncated list has to
 * lead with the reason that matters most.
 */
import { describe, expect, it } from 'vitest'
import { reviewReasons, REVIEW_REASON_TEXT, type ReviewReason } from './reviewReasons.js'
import type { RankedSubmission } from './composite.js'

const entry = (overrides: Partial<RankedSubmission> = {}): RankedSubmission => ({
  submissionId: 1, challengeId: 1, composite: 70,
  fidelityRaw: 70, fidelityNormalised: 70, cohortSize: 20,
  normalisationMethod: 'PERCENTILE', missingDimensions: [],
  weightCovered: 1, partial: false,
  rankGlobal: 10, rankInChallenge: 5, tied: false,
  ...overrides,
})

const reasonsFor = (
  overrides: Partial<RankedSubmission> = {},
  flags: { inCutBand?: boolean; advisoryDecided?: boolean; coverageFloor?: number } = {},
): ReviewReason[] =>
  reviewReasons({
    entry: entry(overrides),
    inCutBand: flags.inCutBand ?? false,
    advisoryDecided: flags.advisoryDecided ?? false,
    coverageFloor: flags.coverageFloor,
  })

describe('what raises a flag', () => {
  it('raises nothing for a cleanly-scored submission clear of the line', () => {
    expect(reasonsFor()).toEqual([])
  })

  it('flags a submission in the cut band', () => {
    expect(reasonsFor({}, { inCutBand: true })).toContain('IN_CUT_BAND')
  })

  it('flags a submission whose position turns on the advisory dimension', () => {
    expect(reasonsFor({}, { advisoryDecided: true })).toContain('ADVISORY_DECIDED')
  })

  it('flags a tie, because the order between tied submissions is arbitrary', () => {
    expect(reasonsFor({ tied: true })).toContain('TIED')
  })

  it('flags a too-small cohort ANYWHERE in the order, not only near the cut', () => {
    // The case this exists for: rank 40, nowhere near the line, position resting on an
    // absolute score while everyone else's is normalised.
    const reasons = reasonsFor({ normalisationMethod: 'ABSOLUTE_FALLBACK', rankGlobal: 40 })
    expect(reasons).toContain('COHORT_BELOW_FLOOR')
  })

  it('flags a dimension that could not be scored at all', () => {
    expect(reasonsFor({ missingDimensions: ['RUNS'], partial: true }))
      .toContain('DIMENSION_UNSCORED')
  })

  it('flags partial evidence within a scored dimension', () => {
    expect(reasonsFor({ partial: true })).toContain('PARTIAL_EVIDENCE')
  })

  it('does NOT add the weaker reason when the stronger one covers it', () => {
    // "A whole dimension is missing" makes "some criteria are missing" noise.
    const reasons = reasonsFor({ missingDimensions: ['RUNS'], partial: true })
    expect(reasons).toContain('DIMENSION_UNSCORED')
    expect(reasons).not.toContain('PARTIAL_EVIDENCE')
  })

  it('does not treat a normal percentile as a reason', () => {
    expect(reasonsFor({ normalisationMethod: 'PERCENTILE' })).not.toContain('COHORT_BELOW_FLOOR')
  })

  it('does not flag a degenerate-uniform cohort as below the floor', () => {
    // An all-equal cohort is large enough; it simply could not separate anyone. That is a
    // different statement, and it is carried by the normalisation method itself.
    expect(reasonsFor({ normalisationMethod: 'DEGENERATE_UNIFORM' }))
      .not.toContain('COHORT_BELOW_FLOOR')
  })
})

describe('ordering and vocabulary', () => {
  it('leads with the advisory flag, the reason most likely to change a decision', () => {
    const reasons = reasonsFor(
      { tied: true, partial: true, normalisationMethod: 'ABSOLUTE_FALLBACK' },
      { inCutBand: true, advisoryDecided: true },
    )
    expect(reasons[0]).toBe('ADVISORY_DECIDED')
    expect(reasons[1]).toBe('IN_CUT_BAND')
  })

  it('collects every applicable reason rather than stopping at the first', () => {
    const reasons = reasonsFor(
      { tied: true, normalisationMethod: 'ABSOLUTE_FALLBACK', missingDimensions: ['RUNS'] },
      { inCutBand: true, advisoryDecided: true },
    )
    expect(reasons).toHaveLength(5)
  })

  it('gives every code plain-language wording', () => {
    const codes: ReviewReason[] = [
      'ADVISORY_DECIDED', 'IN_CUT_BAND', 'TIED',
      'COHORT_BELOW_FLOOR', 'DIMENSION_UNSCORED', 'PARTIAL_EVIDENCE',
    ]
    for (const code of codes) {
      expect(REVIEW_REASON_TEXT[code], code).toBeTruthy()
      // Wording a reviewer reads, not the code spelled out.
      expect(REVIEW_REASON_TEXT[code]).not.toBe(code)
    }
  })

  it('words the advisory reason so it cannot be read as an instruction to demote', () => {
    expect(REVIEW_REASON_TEXT.ADVISORY_DECIDED).toMatch(/must not decide it alone/)
  })
})

describe('a composite built on too little of the rubric', () => {
  /*
   * The event's first full run: across fifteen entries, coverage and rank correlated at +0.61.
   * The entry ranked FIRST had scored 39% of the rubric; the entry ranked LAST had scored 91%.
   * Missing criteria do not merely add uncertainty — because a dimension averages over the
   * weight it covered, they push a composite UP. So below a floor the number is withdrawn
   * rather than qualified.
   */
  it('flags coverage below the floor', () => {
    expect(reasonsFor({ criterionCoverage: 0.39 }, { coverageFloor: 0.7 }))
      .toContain('COVERAGE_TOO_LOW')
  })

  it('does NOT flag coverage at or above the floor', () => {
    expect(reasonsFor({ criterionCoverage: 0.7 }, { coverageFloor: 0.7 }))
      .not.toContain('COVERAGE_TOO_LOW')
    expect(reasonsFor({ criterionCoverage: 0.93 }, { coverageFloor: 0.7 }))
      .not.toContain('COVERAGE_TOO_LOW')
  })

  it('LEADS with it, because it tells a reviewer not to read the score at all', () => {
    // Every other reason qualifies a number. This one withdraws it, so a truncated list must
    // show it first.
    const reasons = reasonsFor(
      { criterionCoverage: 0.3, partial: true, normalisationMethod: 'ABSOLUTE_FALLBACK', tied: true },
      { coverageFloor: 0.7, inCutBand: true, advisoryDecided: true },
    )
    expect(reasons[0]).toBe('COVERAGE_TOO_LOW')
    expect(reasons.length).toBeGreaterThan(3)
  })

  it('is disabled by a floor of 0, so an operator can turn it off without a deploy', () => {
    expect(reasonsFor({ criterionCoverage: 0.1 }, { coverageFloor: 0 }))
      .not.toContain('COVERAGE_TOO_LOW')
    expect(reasonsFor({ criterionCoverage: 0.1 }, {})).not.toContain('COVERAGE_TOO_LOW')
  })

  it('says, in words, that the number is biased UP rather than merely uncertain', () => {
    // A reviewer who reads "partial evidence" assumes the score is conservative. It is not.
    expect(REVIEW_REASON_TEXT.COVERAGE_TOO_LOW).toMatch(/unranked pending review/)
    expect(REVIEW_REASON_TEXT.COVERAGE_TOO_LOW).toMatch(/UP/)
  })
})
