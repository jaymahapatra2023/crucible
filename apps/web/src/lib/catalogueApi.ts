/** The principles and standards an evaluation judges against (E12). */
import { del, get, patch, post, put } from './apiClient.js'

export interface Principle {
  principle_id: number
  code: string
  pillar: string
  name: string
  description: string
  rationale: string
  guidance: string
  evidence_spec: string
  anchor_0: string
  anchor_1: string
  anchor_2: string
  anchor_3: string
  anchor_4: string
  source_refs: string[]
  tags: string[]
  owner: string | null
  active: boolean
  sort_order: number
}

export interface Standard {
  standard_id: number
  code: string
  category: string
  name: string
  description: string
  rationale: string
  evidence_spec: string
  mandatory: boolean
  applies_to: string[]
  tags: string[]
  source_document: string | null
  owner: string | null
  effective_date: string | null
  review_date: string | null
  active: boolean
  sort_order: number
}

export interface Catalogue {
  principles: Principle[]
  standards: Standard[]
  adoptedPrinciples: number
  adoptedStandards: number
  /** Set when nothing has been adopted — the dimension is then not scored at all. */
  note: string | null
}

export interface PrincipleDraft {
  code: string
  pillar: string
  name: string
  description: string
  rationale: string
  guidance: string
  evidenceSpec: string
  anchors: [string, string, string, string, string]
  sourceRefs: string[]
  tags: string[]
  owner: string | null
  sortOrder: number
}

export interface StandardDraft {
  code: string
  category: string
  name: string
  description: string
  rationale: string
  evidenceSpec: string
  mandatory: boolean
  appliesTo: string[]
  tags: string[]
  sourceDocument: string | null
  owner: string | null
  effectiveDate: string | null
  reviewDate: string | null
  sortOrder: number
}

export interface Vocabularies {
  pillars: string[]
  standardCategories: string[]
}

/** Retiring reports whether the row was removed or withdrawn, and why. */
export interface RetireResult {
  deleted: boolean
  reason: string
}

export const getCatalogue = () => get<Catalogue>('/principles')
export const getVocabularies = () => get<Vocabularies>('/principles/vocabularies')

export const createPrinciple = (draft: PrincipleDraft) => post<Principle>('/principles', draft)
export const updatePrinciple = (id: number, draft: PrincipleDraft) =>
  put<Principle>(`/principles/${id}`, draft)
export const retirePrinciple = (id: number) => del<RetireResult>(`/principles/${id}`)
export const setPrincipleAdopted = (id: number, active: boolean) =>
  patch<Principle>(`/principles/${id}`, { active })

export const createStandard = (draft: StandardDraft) => post<Standard>('/standards', draft)
export const updateStandard = (id: number, draft: StandardDraft) =>
  put<Standard>(`/standards/${id}`, draft)
export const retireStandard = (id: number) => del<RetireResult>(`/standards/${id}`)
export const setStandardAdopted = (id: number, active: boolean) =>
  patch<Standard>(`/standards/${id}`, { active })
