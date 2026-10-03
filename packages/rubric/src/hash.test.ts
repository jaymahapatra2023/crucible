import { describe, expect, it } from 'vitest'
import { hashRubric, verifyHash } from './hash.js'
import { DEFAULT_DIMENSION_WEIGHTS, rescaleToOne, roundWeight, sumsToOne, evenDimensionWeights } from './defaults.js'
import { FIXTURE_RUBRIC_ALPHA, FIXTURE_RUBRIC_BETA } from './fixtures.js'
import type { Criterion, Rubric } from './types.js'

const clone = (r: Rubric): Rubric => structuredClone(r)
const hashOf = (r: Rubric): string => hashRubric(r.criteria, r.dimensionWeights)

describe('hashRubric — stability (acceptance 3)', () => {
  it('is deterministic across repeated calls', () => {
    expect(hashOf(FIXTURE_RUBRIC_ALPHA)).toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('returns a 64-character hex digest', () => {
    expect(hashOf(FIXTURE_RUBRIC_ALPHA)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across KEY ORDER in the criterion objects', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    const reordered = a.criteria.map((c) => {
      const entries = Object.entries(c).reverse()
      return Object.fromEntries(entries) as unknown as Criterion
    })
    expect(hashRubric(reordered, a.dimensionWeights)).toBe(hashOf(a))
  })

  it('is stable across KEY ORDER in dimension weights', () => {
    const reversed = Object.fromEntries(
      Object.entries(DEFAULT_DIMENSION_WEIGHTS).reverse(),
    ) as typeof DEFAULT_DIMENSION_WEIGHTS
    expect(hashRubric(FIXTURE_RUBRIC_ALPHA.criteria, reversed)).toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('is stable across WHITESPACE differences', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    const c = a.criteria[0] as Criterion
    c.name = `  ${c.name}  `
    c.description = c.description.replace(/ /g, '   ')
    c.evidenceSpec = `\n${c.evidenceSpec}\n\n`
    c.anchors[0] = `\t${c.anchors[0]} `
    expect(hashOf(a)).toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('is stable across LINE ENDINGS', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    const c = a.criteria[0] as Criterion
    c.description = c.description.replace(/ /g, '\r\n')
    const b = clone(FIXTURE_RUBRIC_ALPHA)
    const cb = b.criteria[0] as Criterion
    cb.description = cb.description.replace(/ /g, '\n')
    expect(hashOf(a)).toBe(hashOf(b))
  })

  it('is stable across CRITERION ORDER — reordering the review screen is not a rubric change', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    a.criteria.reverse()
    a.criteria.forEach((c, i) => { c.sortOrder = i })
    expect(hashOf(a)).toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('ignores identity, status and timestamps — they do not change how anything scores', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    a.rubricId = 'rb_completely_different'
    a.version = 99
    a.status = 'DRAFT'
    a.approvedBy = 'someone.else@test.local'
    a.frozenAt = '2030-01-01T00:00:00.000Z'
    a.criteria.forEach((c) => { c.criterionId = `x_${c.criterionId}` })
    expect(hashOf(a)).toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('ignores review metadata that does not affect judgement', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    ;(a.criteria[0] as Criterion).gateNotes = ['reviewed and accepted']
    expect(hashOf(a)).toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })
})

describe('hashRubric — sensitivity', () => {
  it('changes when a WEIGHT changes', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    const eq = a.criteria.filter((c) => c.dimension === 'ENGINEERING_QUALITY')
    ;(eq[0] as Criterion).weight = 0.5
    ;(eq[1] as Criterion).weight = 0.25
    ;(eq[2] as Criterion).weight = 0.25
    expect(hashOf(a)).not.toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('changes when an ANCHOR changes', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    ;(a.criteria[0] as Criterion).anchors[3] = 'A materially different standard for a 3.'
    expect(hashOf(a)).not.toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('changes when an EVIDENCE SPEC changes', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    ;(a.criteria[0] as Criterion).evidenceSpec = 'Something else entirely must be pointed at.'
    expect(hashOf(a)).not.toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('changes when a DIMENSION WEIGHT changes', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    a.dimensionWeights.CHALLENGE_FIDELITY = 0.35
    a.dimensionWeights.ORIGINALITY = 0.05
    expect(hashOf(a)).not.toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('changes when a criterion is REMOVED', () => {
    const a = clone(FIXTURE_RUBRIC_ALPHA)
    a.criteria.pop()
    expect(hashOf(a)).not.toBe(hashOf(FIXTURE_RUBRIC_ALPHA))
  })

  it('differs between the two challenge fixtures', () => {
    expect(hashOf(FIXTURE_RUBRIC_ALPHA)).not.toBe(hashOf(FIXTURE_RUBRIC_BETA))
  })
})

describe('verifyHash', () => {
  it('confirms a matching hash', () => {
    const h = hashOf(FIXTURE_RUBRIC_ALPHA)
    expect(verifyHash(FIXTURE_RUBRIC_ALPHA.criteria, FIXTURE_RUBRIC_ALPHA.dimensionWeights, h)).toBe(true)
  })

  it('detects tampering after freeze', () => {
    const h = hashOf(FIXTURE_RUBRIC_ALPHA)
    const tampered = clone(FIXTURE_RUBRIC_ALPHA)
    ;(tampered.criteria[0] as Criterion).anchors[4] = 'Anything at all earns full marks.'
    expect(verifyHash(tampered.criteria, tampered.dimensionWeights, h)).toBe(false)
  })
})

describe('weight helpers', () => {
  it('sumsToOne accepts exact and near-exact totals', () => {
    expect(sumsToOne([0.5, 0.5])).toBe(true)
    expect(sumsToOne([0.333333, 0.333333, 0.333334])).toBe(true)
    expect(sumsToOne([0.5, 0.4])).toBe(false)
    expect(sumsToOne([])).toBe(false)
  })

  it('rescaleToOne produces weights summing to exactly 1', () => {
    for (const input of [[1, 1, 1], [2, 3, 5], [0.1, 0.2], [7]]) {
      const out = rescaleToOne(input)
      expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    }
  })

  it('rescaleToOne preserves relative proportions', () => {
    const [a, b] = rescaleToOne([1, 3])
    expect((b as number) / (a as number)).toBeCloseTo(3, 6)
  })

  it('rescaleToOne handles an all-zero input by splitting evenly', () => {
    expect(rescaleToOne([0, 0, 0, 0])).toEqual([0.25, 0.25, 0.25, 0.25])
  })

  it('roundWeight is stable to six places', () => {
    expect(roundWeight(1 / 3)).toBe(0.333333)
    expect(roundWeight(0.1 + 0.2)).toBe(0.3)
  })

  it('evenDimensionWeights covers all five dimensions', () => {
    const w = evenDimensionWeights()
    expect(Object.keys(w)).toHaveLength(5)
  })
})
