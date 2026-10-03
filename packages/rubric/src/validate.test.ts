import { describe, expect, it } from 'vitest'
import { validateRubric, assertScoreable, similarity } from './validate.js'
import { FIXTURE_RUBRIC_ALPHA, FIXTURE_RUBRIC_BETA } from './fixtures.js'
import type { Criterion, Rubric } from './types.js'

/** Deep clone so a test's mutation cannot leak into another test's fixture. */
const clone = (r: Rubric): Rubric => structuredClone(r)

const codes = (r: Rubric): string[] => validateRubric(r).issues.map((i) => i.code)

describe('fixtures are themselves valid (acceptance 4)', () => {
  it.each([
    ['alpha', FIXTURE_RUBRIC_ALPHA],
    ['beta', FIXTURE_RUBRIC_BETA],
  ])('%s fixture validates with no errors', (_name, rubric) => {
    const result = validateRubric(rubric)
    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('both fixtures carry the challenge-agnostic dimensions, as finding F5 requires', () => {
    for (const rubric of [FIXTURE_RUBRIC_ALPHA, FIXTURE_RUBRIC_BETA]) {
      const dims = new Set(rubric.criteria.map((c) => c.dimension))
      expect(dims).toContain('ENGINEERING_QUALITY')
      expect(dims).toContain('PRINCIPLES_STANDARDS')
      expect(dims).toContain('RUNS')
      expect(dims).toContain('ORIGINALITY')
      expect(dims).toContain('CHALLENGE_FIDELITY')
    }
  })

  it('fixtures use the default dimension weights from the plan', () => {
    expect(FIXTURE_RUBRIC_ALPHA.dimensionWeights).toEqual({
      CHALLENGE_FIDELITY: 0.3, ENGINEERING_QUALITY: 0.25,
      PRINCIPLES_STANDARDS: 0.2, RUNS: 0.15, ORIGINALITY: 0.1,
    })
  })
})

describe('weights sum to 1.0 per dimension (acceptance 2)', () => {
  it('rejects a dimension whose criterion weights do not sum to 1', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const target = r.criteria.find((c) => c.dimension === 'ENGINEERING_QUALITY') as Criterion
    target.weight = 0.9
    expect(codes(r)).toContain('DIMENSION_WEIGHTS_NOT_ONE')
    expect(validateRubric(r).valid).toBe(false)
  })

  it('states the actual total so a reviewer can see how far off it is', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const target = r.criteria.find((c) => c.dimension === 'PRINCIPLES_STANDARDS') as Criterion
    target.weight = 0.1
    const issue = validateRubric(r).errors.find((e) => e.code === 'DIMENSION_WEIGHTS_NOT_ONE')
    expect(issue?.message).toMatch(/sum to 0\.6000/)
  })

  it('accepts weights that sum to 1 within floating-point tolerance', () => {
    const r = clone(FIXTURE_RUBRIC_BETA)
    const cf = r.criteria.filter((c) => c.dimension === 'CHALLENGE_FIDELITY')
    // Thirds cannot be represented exactly; the validator must not reject them.
    cf.forEach((c, i) => { c.weight = i === 0 ? 0.333334 : 0.333333 })
    if (cf.length === 2) cf.forEach((c, i) => { c.weight = i === 0 ? 0.5 : 0.5 })
    expect(validateRubric(r).errors.filter((e) => e.code === 'DIMENSION_WEIGHTS_NOT_ONE')).toEqual([])
  })

  it('rejects dimension weights that do not sum to 1 across the rubric', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    r.dimensionWeights.CHALLENGE_FIDELITY = 0.5
    expect(codes(r)).toContain('RUBRIC_WEIGHTS_NOT_ONE')
  })

  it('ignores a dimension that has no criteria when checking criterion weights', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    r.criteria = r.criteria.filter((c) => c.dimension !== 'ORIGINALITY')
    const errs = validateRubric(r).errors.filter((e) => e.code === 'DIMENSION_WEIGHTS_NOT_ONE')
    expect(errs).toEqual([])
  })

  it('warns when a weighted dimension has no criteria to apply the weight to', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    r.criteria = r.criteria.filter((c) => c.dimension !== 'ORIGINALITY')
    const warning = validateRubric(r).warnings.find((w) => w.code === 'DIMENSION_WEIGHTED_BUT_EMPTY')
    expect(warning?.message).toMatch(/10% of the composite but has no criteria/)
  })
})

describe('evidence_spec is mandatory (acceptance 2)', () => {
  it('rejects an empty evidence spec', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    ;(r.criteria[0] as Criterion).evidenceSpec = '   '
    expect(codes(r)).toContain('EVIDENCE_SPEC_EMPTY')
  })

  it('rejects a missing evidence spec at the schema level', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA) as unknown as { criteria: Array<Record<string, unknown>> }
    delete r.criteria[0]!['evidenceSpec']
    expect(validateRubric(r).valid).toBe(false)
  })
})

describe('five anchors, materially distinct (acceptance 2, E02-S05 #3)', () => {
  it('rejects a criterion missing an anchor', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA) as unknown as { criteria: Array<{ anchors: Record<string, unknown> }> }
    delete r.criteria[0]!.anchors['3']
    const result = validateRubric(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes('anchors.3'))).toBe(true)
  })

  it('rejects an empty anchor', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    ;(r.criteria[0] as Criterion).anchors[2] = ''
    expect(validateRubric(r).valid).toBe(false)
  })

  it('rejects identical adjacent anchors — they cannot distinguish two scores', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const c = r.criteria[0] as Criterion
    c.anchors[2] = 'The feature is partly present.'
    c.anchors[3] = 'The feature is partly present.'
    expect(codes(r)).toContain('ANCHORS_IDENTICAL')
    expect(validateRubric(r).valid).toBe(false)
  })

  it('warns on near-identical adjacent anchors', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const c = r.criteria[0] as Criterion
    c.anchors[2] = 'The feed is consumed and parsed for the main path'
    c.anchors[3] = 'The feed is consumed and parsed for the main path now'
    const warn = validateRubric(r).warnings.find((w) => w.code === 'ANCHORS_NEAR_IDENTICAL')
    expect(warn).toBeDefined()
  })

  it('is case- and whitespace-insensitive when comparing anchors', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const c = r.criteria[0] as Criterion
    c.anchors[0] = 'No evidence.'
    c.anchors[1] = '  NO   EVIDENCE.  '
    expect(codes(r)).toContain('ANCHORS_IDENTICAL')
  })
})

describe('source_ref required for CHALLENGE_FIDELITY (acceptance 2)', () => {
  it('rejects a fidelity criterion with no source_ref', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const cf = r.criteria.find((c) => c.dimension === 'CHALLENGE_FIDELITY') as Criterion
    delete cf.sourceRef
    expect(codes(r)).toContain('SOURCE_REF_MISSING')
  })

  it('rejects a blank source_ref', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const cf = r.criteria.find((c) => c.dimension === 'CHALLENGE_FIDELITY') as Criterion
    cf.sourceRef = '   '
    expect(codes(r)).toContain('SOURCE_REF_MISSING')
  })

  it('does NOT require source_ref for challenge-agnostic dimensions', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    for (const c of r.criteria) if (c.dimension !== 'CHALLENGE_FIDELITY') delete c.sourceRef
    expect(codes(r)).not.toContain('SOURCE_REF_MISSING')
  })
})

describe('structural validation', () => {
  it('rejects duplicate criterion ids', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    ;(r.criteria[1] as Criterion).criterionId = (r.criteria[0] as Criterion).criterionId
    expect(codes(r)).toContain('DUPLICATE_CRITERION_ID')
  })

  it('rejects a rubric with no criteria', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    r.criteria = []
    expect(codes(r)).toContain('NO_CRITERIA')
  })

  it('reports every semantic problem at once, not just the first', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    ;(r.criteria[0] as Criterion).evidenceSpec = '   '
    ;(r.criteria[1] as Criterion).weight = 0.99
    r.dimensionWeights.RUNS = 0.9
    const errors = validateRubric(r).errors
    expect(errors.map((e) => e.code)).toEqual(expect.arrayContaining([
      'EVIDENCE_SPEC_EMPTY', 'DIMENSION_WEIGHTS_NOT_ONE', 'RUBRIC_WEIGHTS_NOT_ONE',
    ]))
  })

  it('short-circuits to schema errors when the shape itself is wrong', () => {
    // A structurally invalid rubric reports schema problems only: running semantic checks over
    // a malformed object would produce confusing noise on top of the real cause.
    const r = clone(FIXTURE_RUBRIC_ALPHA) as unknown as Record<string, unknown>
    r['criteria'] = 'not an array'
    const result = validateRubric(r)
    expect(result.valid).toBe(false)
    expect(result.errors.every((e) => e.code === 'SCHEMA_INVALID')).toBe(true)
  })

  it('surfaces a quality-gate NEEDS_REWRITE flag as a warning a reviewer must see', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    const c = r.criteria[0] as Criterion
    c.needsRewrite = true
    c.gateNotes = ['evidence_spec does not describe anything locatable in a repository']
    const warn = validateRubric(r).warnings.find((w) => w.code === 'NEEDS_REWRITE')
    expect(warn?.message).toMatch(/locatable in a repository/)
  })

  it('rejects a non-object input without throwing', () => {
    for (const bad of [null, undefined, 'a rubric', 42, []]) {
      expect(validateRubric(bad).valid).toBe(false)
    }
  })
})

describe('assertScoreable (E02-S07 acceptance 5)', () => {
  it('accepts a valid frozen rubric', () => {
    expect(() => assertScoreable(FIXTURE_RUBRIC_ALPHA)).not.toThrow()
  })

  it.each(['DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED'] as const)(
    'refuses to score against a %s rubric', (status) => {
      const r = clone(FIXTURE_RUBRIC_ALPHA)
      r.status = status
      expect(() => assertScoreable(r)).toThrow(/refuses to start/)
    })

  it('refuses a frozen rubric that no longer validates', () => {
    const r = clone(FIXTURE_RUBRIC_ALPHA)
    ;(r.criteria[0] as Criterion).evidenceSpec = ''
    expect(() => assertScoreable(r)).toThrow(/FROZEN but does not validate/)
  })
})

describe('similarity helper', () => {
  it('scores identical strings 1', () => {
    expect(similarity('a b c', 'a b c')).toBe(1)
  })
  it('scores disjoint strings 0', () => {
    expect(similarity('alpha beta', 'gamma delta')).toBe(0)
  })
  it('handles empty input without dividing by zero', () => {
    expect(similarity('', '')).toBe(1)
    expect(similarity('', 'x')).toBe(0)
  })
})
