/**
 * The rubric contract (E02-S03, plan §II.3).
 *
 * This is the interface every later component compiles against. It is deliberately fixed before
 * any real rubric exists, so scoring can be built against the *schema* rather than waiting on
 * committee decisions about *content* (finding F4).
 */

/** The five scoring dimensions. Fixed; a new dimension is a schema change, not configuration. */
export const DIMENSIONS = [
  'CHALLENGE_FIDELITY',
  'ENGINEERING_QUALITY',
  'PRINCIPLES_STANDARDS',
  'RUNS',
  'ORIGINALITY',
] as const
export type Dimension = (typeof DIMENSIONS)[number]

export const RUBRIC_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'FROZEN', 'SUPERSEDED'] as const
export type RubricStatus = (typeof RUBRIC_STATUSES)[number]

/** Anchors for every point on the 0–4 scale. All five are mandatory and must be distinct. */
export interface Anchors {
  0: string
  1: string
  2: string
  3: string
  4: string
}

export interface Criterion {
  criterionId: string
  dimension: Dimension
  name: string
  description: string
  /**
   * Weight within its own dimension. Weights sum to 1.0 per dimension — not across the rubric —
   * so a dimension can be re-weighted without touching criteria in other dimensions.
   */
  weight: number
  /** What a reader could point to in a repository. Mandatory, and quality-gated (E02-S05). */
  evidenceSpec: string
  anchors: Anchors
  /** Traceability to the brief. Mandatory for CHALLENGE_FIDELITY (plan §II.3). */
  sourceRef?: string
  sortOrder: number
  /** Set by the quality gate when a criterion could not be repaired (E02-S05 acceptance 2). */
  needsRewrite?: boolean
  /** Why the gate flagged it, shown to the reviewer. */
  gateNotes?: string[]
}

/** Relative weight of each dimension in the composite. Sums to 1.0 across the rubric. */
export type DimensionWeights = Record<Dimension, number>

export interface Rubric {
  rubricId: string
  challengeId: string
  version: number
  status: RubricStatus
  /** SHA-256 over the normalised criteria and dimension weights. Set at freeze. */
  contentHash: string | null
  dimensionWeights: DimensionWeights
  criteria: Criterion[]
  generatedAt: string | null
  approvedBy: string | null
  approvedAt: string | null
  frozenAt: string | null
  publishedAt: string | null
}

/** A rubric that has passed validation and been frozen — the only kind scoring will accept. */
export interface FrozenRubric extends Rubric {
  status: 'FROZEN'
  contentHash: string
  frozenAt: string
}

export function isFrozen(rubric: Rubric): rubric is FrozenRubric {
  return rubric.status === 'FROZEN' && rubric.contentHash !== null && rubric.frozenAt !== null
}

/** Dimensions whose criteria must carry a `sourceRef` back to the brief. */
export const SOURCE_REF_REQUIRED: readonly Dimension[] = ['CHALLENGE_FIDELITY']

/** The RUNS dimension is objective and never model-scored (E05-S04 acceptance 3). */
export const OBJECTIVE_DIMENSIONS: readonly Dimension[] = ['RUNS']

/** Advisory dimensions may never be the sole reason a submission falls below the cut (E06-S05). */
export const ADVISORY_DIMENSIONS: readonly Dimension[] = ['ORIGINALITY']
