/**
 * Stable content hashing (E02-S03 acceptance 3).
 *
 * The hash is what lets a score name the standard it was judged by. It must therefore be
 * reproducible from the *meaning* of a rubric, not its formatting: identical across key order,
 * whitespace, line endings and JSON serialiser quirks.
 *
 * Deliberately excluded from the hash: ids, status, timestamps, and review metadata. Two rubrics
 * with the same criteria and weights judge submissions identically, so they must hash the same
 * even if one was approved on a different day.
 */
import { createHash } from 'node:crypto'
import type { Criterion, DimensionWeights } from './types.js'
import { roundWeight } from './defaults.js'

/** Collapse runs of whitespace and trim, so re-wrapped prose does not change the hash. */
function normaliseText(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

/** A criterion reduced to exactly what affects judgement, with keys in a fixed order. */
function canonicalCriterion(c: Criterion): unknown[] {
  return [
    c.dimension,
    normaliseText(c.name),
    normaliseText(c.description),
    roundWeight(c.weight),
    normaliseText(c.evidenceSpec),
    [
      normaliseText(c.anchors[0]),
      normaliseText(c.anchors[1]),
      normaliseText(c.anchors[2]),
      normaliseText(c.anchors[3]),
      normaliseText(c.anchors[4]),
    ],
    c.sourceRef === undefined ? null : normaliseText(c.sourceRef),
  ]
}

/**
 * Hash a rubric's judgement-bearing content.
 *
 * Criteria are sorted by (dimension, name) rather than kept in display order: reordering the
 * review screen does not change how a submission scores, so it must not change the hash.
 */
export function hashRubric(
  criteria: readonly Criterion[],
  dimensionWeights: DimensionWeights,
): string {
  const canonicalCriteria = [...criteria]
    .map(canonicalCriterion)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

  const canonicalWeights = Object.keys(dimensionWeights)
    .sort()
    .map((k) => [k, roundWeight(dimensionWeights[k as keyof DimensionWeights])])

  const payload = JSON.stringify({ c: canonicalCriteria, w: canonicalWeights })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** Verify a rubric's recorded hash still matches its content — used on every scoring start. */
export function verifyHash(
  criteria: readonly Criterion[],
  dimensionWeights: DimensionWeights,
  expected: string,
): boolean {
  return hashRubric(criteria, dimensionWeights) === expected
}
