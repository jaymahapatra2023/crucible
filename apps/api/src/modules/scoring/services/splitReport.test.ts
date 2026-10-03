/**
 * The median helper behind challenge split reporting (E07-S05 acceptance 3).
 *
 * A median rather than a mean, deliberately: with twenty-five submissions per challenge, one
 * abandoned scaffold scoring 4 drags a mean down far enough to make a strong field look weak,
 * and the comparison this figure exists to support would then mislead.
 */
import { describe, expect, it } from 'vitest'
import { median } from './splitReport.js'

describe('median', () => {
  it('is the middle value for an odd count', () => {
    expect(median([10, 90, 50])).toBe(50)
  })

  it('averages the two middles for an even count', () => {
    expect(median([10, 20, 30, 40])).toBe(25)
  })

  it('is null for an empty set, never zero', () => {
    // Zero would be read as "this challenge scored nothing", which is a different claim from
    // "nothing in this challenge was scored".
    expect(median([])).toBeNull()
  })

  it('handles a single value', () => {
    expect(median([73.4])).toBe(73.4)
  })

  it('does not depend on input order', () => {
    expect(median([5, 1, 4, 2, 3])).toBe(median([1, 2, 3, 4, 5]))
  })

  it('RESISTS the outlier a mean would not', () => {
    const scores = [70, 72, 74, 76, 0]
    expect(median(scores)).toBe(72)
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    expect(mean).toBeLessThan(60)
  })

  it('rounds to one decimal place', () => {
    expect(median([1, 2])).toBe(1.5)
    expect(median([10.04, 10.08])).toBe(10.1)
  })
})
