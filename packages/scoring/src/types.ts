/**
 * Scoring types (E06, E07).
 */
import type { Dimension } from '@crucible/rubric'

/** A located source excerpt — the evidence every score must carry (P0 constraint 2, P4.6). */
export interface Excerpt {
  path: string
  lineStart: number
  lineEnd: number
  text: string
  /** Why this excerpt was selected, so a reader can judge whether the selection was fair. */
  reason: string
  relevance: number
}

/** What the model is given for one criterion (E06-S01). */
export interface ScoringContext {
  criterionId: string
  criterionName: string
  /** Source excerpts, with paths and line numbers. */
  excerpts: Excerpt[]
  /** Repository facts the model should not have to infer from the excerpts. */
  repoSummary: string
  /** Bytes of excerpt text included. Recorded per call (acceptance 3). */
  budgetUsedBytes: number
  budgetLimitBytes: number
  /** True when relevant-looking files existed but did not fit the budget. */
  budgetTruncated: boolean
  /** Files searched, so "we looked everywhere" is a checkable claim rather than an assertion. */
  filesSearched: number
  /**
   * True when nothing in the repository matched the criterion's evidence specification.
   *
   * This is NOT a low score (acceptance 4). A criterion whose evidence cannot be located is
   * unscoreable, and recording it as a zero would silently convert "we could not check" into
   * "they did not do it".
   */
  insufficientEvidence: boolean
  /** Why evidence was judged insufficient, for the reviewer. */
  insufficientReason: string | null
}

export const NON_SCORES = ['INSUFFICIENT_EVIDENCE', 'SCORING_FAILED', 'NOT_APPLICABLE'] as const
export type NonScore = (typeof NON_SCORES)[number]

/** One criterion's result: a score, or an honest non-score. */
export interface CriterionOutcome {
  criterionId: string
  dimension: Dimension
  /** 0–4, or null when a non-score applies. Never defaulted to zero. */
  rawScore: number | null
  nonScore: NonScore | null
  confidence: number
  rationale: string
  evidence: Excerpt[]
  /** The anchor text the score was matched against, quoted back for the reviewer. */
  anchorMatched: string | null
}
