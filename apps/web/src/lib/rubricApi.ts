/**
 * Rubric review API surface used by the review screen (E02-S06).
 */
import { del, get, patch, post, put } from './apiClient.js'

export const DIMENSIONS = [
  'CHALLENGE_FIDELITY', 'ENGINEERING_QUALITY', 'PRINCIPLES_STANDARDS', 'RUNS', 'ORIGINALITY',
] as const
export type Dimension = (typeof DIMENSIONS)[number]

export const DIMENSION_LABELS: Record<Dimension, string> = {
  CHALLENGE_FIDELITY: 'Challenge fidelity',
  ENGINEERING_QUALITY: 'Engineering quality',
  PRINCIPLES_STANDARDS: 'Principles & standards',
  RUNS: 'Runs (build & execute)',
  // Re-anchored in E35: this measures whether the approach is inventive, not how much of the
  // code the team wrote. The label is what a committee author reads while writing criteria,
  // so a stale one steers them into authoring for the old construct.
  ORIGINALITY: 'Inventiveness of the approach',
}

export interface Criterion {
  criterionId: string
  dimension: Dimension
  name: string
  description: string
  weight: number
  evidenceSpec: string
  anchors: Record<'0' | '1' | '2' | '3' | '4', string>
  sourceRef?: string
  sortOrder: number
  needsRewrite?: boolean
  gateNotes?: string[]
}

export interface Rubric {
  rubricId: string
  challengeId: string
  version: number
  status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'FROZEN' | 'SUPERSEDED'
  contentHash: string | null
  dimensionWeights: Record<Dimension, number>
  criteria: Criterion[]
  approvedBy: string | null
  frozenAt: string | null
  publishedAt: string | null
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  criterionId?: string
  dimension?: Dimension
}

export interface Readiness {
  canApprove: boolean
  unacknowledgedWarnings: string[]
  report: { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }
}

export const getRubric = (id: string) => get<Rubric>(`/rubrics/${id}`)
export const getReadiness = (id: string) => get<Readiness>(`/rubrics/${id}/readiness`)

export const setCriterionWeights = (id: string, dimension: Dimension, weights: Record<string, number>) =>
  put<Criterion[]>(`/rubrics/${id}/criteria/weights`, { dimension, weights })

export const setDimensionWeights = (id: string, weights: Record<Dimension, number>) =>
  put<Rubric>(`/rubrics/${id}/dimension-weights`, { weights })

export interface CriterionEdit {
  name: string
  description: string
  evidenceSpec: string
  anchors: Record<'0' | '1' | '2' | '3' | '4', string>
  sourceRef: string | null
}

/**
 * Rewrite a criterion on a draft rubric (E18-S01).
 *
 * The quality gate flags criteria as NEEDS_REWRITE — deliberately, rather than dropping them —
 * and until now offered no way to rewrite them.
 */
export const updateCriterion = (id: string, criterionId: string, edit: CriterionEdit) =>
  patch<Criterion>(`/rubrics/${id}/criteria/${criterionId}`, edit)

export const removeCriterion = (id: string, criterionId: string) =>
  del(`/rubrics/${id}/criteria/${criterionId}`)

export const editCriterion = (id: string, criterionId: string, patchBody: Partial<Criterion>) =>
  patch<Criterion>(`/rubrics/${id}/criteria/${criterionId}`, patchBody)

/**
 * Start a new DRAFT version.
 *
 * `copyFrom` carries the source version's criteria and weights forward. A committee correcting
 * one weight should not have to retype the whole rubric — that is how a correction becomes a
 * rewrite, and a rewrite is not comparable with what teams were shown.
 */
export const createRubricVersion = (challengeId: string | number, copyFrom?: string) =>
  post<Rubric>(`/challenges/${challengeId}/rubrics`, copyFrom ? { copyFrom } : {})

export const approveRubric = (id: string, acknowledgedWarnings: string[]) =>
  post<Rubric>(`/rubrics/${id}/approve`, { acknowledgedWarnings })

export const freezeRubric = (id: string) => post<Rubric>(`/rubrics/${id}/freeze`)
export const publishRubric = (id: string) => post<Rubric>(`/rubrics/${id}/publish`)

/** Sum a dimension's criterion weights — the running total E02-S06 acceptance 2 requires. */
export function dimensionTotal(criteria: readonly Criterion[], dimension: Dimension): number {
  return criteria
    .filter((c) => c.dimension === dimension)
    .reduce((sum, c) => sum + c.weight, 0)
}

/** Within floating-point tolerance of 1.0. Mirrors the server's own bar. */
export function sumsToOne(total: number): boolean {
  return Math.abs(total - 1) <= 1e-6
}
