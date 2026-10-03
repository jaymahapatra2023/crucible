/**
 * Rubric validation (E02-S03 acceptance 2).
 *
 * Returns a *report* rather than throwing, because most callers need to show a reviewer every
 * problem at once (E02-S06) rather than stop at the first. Approval is gated on `valid`.
 *
 * Errors block approval. Warnings do not, but E02-S06 requires them to be explicitly
 * acknowledged — a reviewer must not be able to approve a rubric without having seen them.
 */
import { DIMENSIONS, SOURCE_REF_REQUIRED, type Criterion, type Dimension, type Rubric } from './types.js'
import { sumsToOne, WEIGHT_TOLERANCE } from './defaults.js'
import { rubricSchema } from './schema.js'

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  /** Which criterion it concerns, when it concerns one. */
  criterionId?: string
  dimension?: Dimension
}

export interface ValidationReport {
  valid: boolean
  issues: ValidationIssue[]
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

function report(issues: ValidationIssue[]): ValidationReport {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return { valid: errors.length === 0, issues, errors, warnings }
}

/**
 * Above this token overlap, two adjacent anchors are treated as too alike to score against.
 * Tuned so that a one-word difference in a ten-word anchor still flags — that is precisely the
 * "materially distinct" failure E02-S05 acceptance 3 is written to catch.
 */
const NEAR_IDENTICAL_THRESHOLD = 0.85

/** Anchors that say materially the same thing cannot distinguish a 2 from a 3 (E02-S05 #3). */
function anchorsAreDistinct(c: Criterion): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const levels = [0, 1, 2, 3, 4] as const
  const normalised = levels.map((l) => c.anchors[l].toLowerCase().replace(/\s+/g, ' ').trim())

  for (let i = 0; i < normalised.length - 1; i++) {
    const a = normalised[i] as string
    const b = normalised[i + 1] as string
    if (a === b) {
      issues.push({
        severity: 'error',
        code: 'ANCHORS_IDENTICAL',
        message: `Anchors ${i} and ${i + 1} are identical, so they cannot distinguish those scores.`,
        criterionId: c.criterionId,
        dimension: c.dimension,
      })
    } else if (similarity(a, b) >= NEAR_IDENTICAL_THRESHOLD) {
      issues.push({
        severity: 'warning',
        code: 'ANCHORS_NEAR_IDENTICAL',
        message: `Anchors ${i} and ${i + 1} are nearly identical; a scorer will not reliably tell them apart.`,
        criterionId: c.criterionId,
        dimension: c.dimension,
      })
    }
  }
  return issues
}

/** Token-overlap similarity. Crude on purpose — it flags for a human, it does not decide. */
export function similarity(a: string, b: string): number {
  const ta = new Set(a.split(/\W+/).filter(Boolean))
  const tb = new Set(b.split(/\W+/).filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return a === b ? 1 : 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / Math.max(ta.size, tb.size)
}

function validateCriterion(c: Criterion): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const at = { criterionId: c.criterionId, dimension: c.dimension }

  if (c.evidenceSpec.trim() === '') {
    issues.push({
      severity: 'error', code: 'EVIDENCE_SPEC_EMPTY',
      message: 'evidence_spec is mandatory: a criterion with no evidence specification cannot be scored.',
      ...at,
    })
  }

  if (SOURCE_REF_REQUIRED.includes(c.dimension) && !c.sourceRef?.trim()) {
    issues.push({
      severity: 'error', code: 'SOURCE_REF_MISSING',
      message: `source_ref is mandatory for ${c.dimension} criteria, so a score can be traced back to the brief.`,
      ...at,
    })
  }

  if (c.weight < 0 || c.weight > 1) {
    issues.push({
      severity: 'error', code: 'WEIGHT_OUT_OF_RANGE',
      message: `Weight ${c.weight} is outside 0–1.`, ...at,
    })
  }

  if (c.needsRewrite) {
    issues.push({
      severity: 'warning', code: 'NEEDS_REWRITE',
      message: `The quality gate could not make this criterion checkable: ${(c.gateNotes ?? []).join('; ') || 'no detail recorded'}`,
      ...at,
    })
  }

  issues.push(...anchorsAreDistinct(c))
  return issues
}

/** Weights must sum to 1.0 within each dimension that has criteria (acceptance 2). */
function validateDimensionWeights(criteria: readonly Criterion[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const dimension of DIMENSIONS) {
    const inDimension = criteria.filter((c) => c.dimension === dimension)
    if (inDimension.length === 0) continue

    const weights = inDimension.map((c) => c.weight)
    if (!sumsToOne(weights)) {
      const total = weights.reduce((a, b) => a + b, 0)
      issues.push({
        severity: 'error', code: 'DIMENSION_WEIGHTS_NOT_ONE',
        message:
          `Criterion weights in ${dimension} sum to ${total.toFixed(4)}, not 1.0 ` +
          `(tolerance ${WEIGHT_TOLERANCE}). Approval is blocked until they do.`,
        dimension,
      })
    }
  }
  return issues
}

export function validateRubric(input: unknown): ValidationReport {
  const parsed = rubricSchema.safeParse(input)
  if (!parsed.success) {
    return report(parsed.error.issues.map((i) => ({
      severity: 'error' as const,
      code: 'SCHEMA_INVALID',
      message: `${i.path.join('.') || '(root)'}: ${i.message}`,
    })))
  }

  const rubric = parsed.data as Rubric
  const issues: ValidationIssue[] = []

  if (rubric.criteria.length === 0) {
    issues.push({ severity: 'error', code: 'NO_CRITERIA', message: 'A rubric must have at least one criterion.' })
  }

  const ids = new Set<string>()
  for (const c of rubric.criteria) {
    if (ids.has(c.criterionId)) {
      issues.push({
        severity: 'error', code: 'DUPLICATE_CRITERION_ID',
        message: `Criterion id '${c.criterionId}' appears more than once.`, criterionId: c.criterionId,
      })
    }
    ids.add(c.criterionId)
    issues.push(...validateCriterion(c))
  }

  issues.push(...validateDimensionWeights(rubric.criteria))

  // Dimension weights must sum to 1.0 across the rubric.
  const dimensionTotals = DIMENSIONS.map((d) => rubric.dimensionWeights[d])
  if (!sumsToOne(dimensionTotals)) {
    const total = dimensionTotals.reduce((a, b) => a + b, 0)
    issues.push({
      severity: 'error', code: 'RUBRIC_WEIGHTS_NOT_ONE',
      message: `Dimension weights sum to ${total.toFixed(4)}, not 1.0.`,
    })
  }

  // A weighted dimension with no criteria silently contributes nothing to the composite.
  for (const dimension of DIMENSIONS) {
    const weight = rubric.dimensionWeights[dimension]
    const count = rubric.criteria.filter((c) => c.dimension === dimension).length
    if (weight > 0 && count === 0 && dimension !== 'RUNS') {
      issues.push({
        severity: 'warning', code: 'DIMENSION_WEIGHTED_BUT_EMPTY',
        message:
          `${dimension} carries ${(weight * 100).toFixed(0)}% of the composite but has no criteria, ` +
          `so that weight will not be applied to anything.`,
        dimension,
      })
    }
  }

  return report(issues)
}

/** Convenience guard used at the top of scoring: refuse anything that is not valid AND frozen. */
export function assertScoreable(rubric: Rubric): void {
  if (rubric.status !== 'FROZEN') {
    throw new Error(
      `Rubric ${rubric.rubricId} is '${rubric.status}'. Scoring refuses to start against a rubric ` +
        `that is not FROZEN (E02-S07 acceptance 5).`,
    )
  }
  const result = validateRubric(rubric)
  if (!result.valid) {
    throw new Error(
      `Rubric ${rubric.rubricId} is FROZEN but does not validate: ` +
        result.errors.map((e) => e.message).join('; '),
    )
  }
}
