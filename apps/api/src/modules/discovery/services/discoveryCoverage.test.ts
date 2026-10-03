/**
 * Discovery coverage over a ranked field (E15-S04).
 *
 * The distinction the whole read model exists for: a cohort where NOBODY was described is
 * consistent and therefore fair, and one where SOME were is not. Collapsing them would either
 * warn on every ordinary run — training a reviewer to ignore the warning — or stay silent on
 * the one case where a ranking orders submissions judged on unequal evidence.
 */
import { describe as group, expect, it } from 'vitest'
import { describe } from './discoveryCoverage.js'

group('a field nobody described', () => {
  it('is COMPLETE-by-consistency, not a warning', () => {
    const coverage = describe(50, 0, 0)
    expect(coverage.state).toBe('NONE')
    expect(coverage.uneven).toBe(false)
  })

  it('says every submission was judged on the same evidence', () => {
    expect(describe(50, 0, 0).note).toMatch(/judged on the same evidence/i)
  })
})

group('a field described in full', () => {
  it('reports completion without a caveat', () => {
    const coverage = describe(50, 50, 50)
    expect(coverage.state).toBe('COMPLETE')
    expect(coverage.uneven).toBe(false)
    expect(coverage.note).toMatch(/All 50 submissions were described/)
  })
})

group('a field described in part — the unfair one', () => {
  it('is the only state flagged uneven', () => {
    const coverage = describe(50, 38, 38)
    expect(coverage.state).toBe('PARTIAL')
    expect(coverage.uneven).toBe(true)
  })

  it('names how many were judged on less context than their competitors', () => {
    const note = describe(50, 38, 38).note
    expect(note).toMatch(/Only 38 of 50/)
    expect(note).toMatch(/The other 12 were judged on less context/)
  })

  it('says what to do about it rather than only that it happened', () => {
    // A warning with no action is a warning a reviewer learns to scroll past.
    expect(describe(50, 38, 38).note).toMatch(/re-score, or treat this ranking as provisional/i)
  })

  it('counts a single undescribed submission as uneven', () => {
    // One submission scored on less context than 49 others is still an unfair ranking.
    expect(describe(50, 49, 49).uneven).toBe(true)
  })
})

group('arithmetic', () => {
  it('reports how many were never described', () => {
    expect(describe(50, 38, 30).undiscovered).toBe(12)
  })

  it('keeps "described" and "described successfully" apart', () => {
    // A discovery that ran and failed every concern is still a run that happened. Counting it
    // as completed would overstate the evidence; counting it as absent would understate the
    // attempt — and the operator needs both numbers.
    const coverage = describe(50, 38, 30)
    expect(coverage.discovered).toBe(38)
    expect(coverage.completed).toBe(30)
  })

  it('handles an empty field without inventing a state', () => {
    const coverage = describe(0, 0, 0)
    expect(coverage.uneven).toBe(false)
    expect(coverage.note).toMatch(/Nothing has been scored/)
  })
})
