/**
 * Evidence — the file-and-line reference that makes a judgement appealable (P0 constraint 2,
 * P4.6, P7.3). Every model-produced score carries at least one of these or it is not a score.
 */
import { z } from 'zod'

export const evidenceSchema = z.object({
  /** Repository-relative path, POSIX separators, no leading slash. */
  path: z.string().min(1).max(1024),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  /** The actual source text the judgement rests on, size-capped for storage. */
  excerpt: z.string().min(1).max(4000),
}).refine((e) => e.lineEnd >= e.lineStart, {
  message: 'lineEnd must be greater than or equal to lineStart',
  path: ['lineEnd'],
})

export type Evidence = z.infer<typeof evidenceSchema>

/** P4.5 — confidence accompanies every extracted fact. */
export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]
export const confidenceLevelSchema = z.enum(CONFIDENCE_LEVELS)

/**
 * The three honest non-scores. A criterion that cannot be judged produces one of these — never
 * a zero (P4.2, E06-S02 acceptance 3, E06-S01 acceptance 4).
 */
export const NON_SCORE_OUTCOMES = ['INSUFFICIENT_EVIDENCE', 'SCORING_FAILED', 'NOT_APPLICABLE'] as const
export type NonScoreOutcome = (typeof NON_SCORE_OUTCOMES)[number]
export const nonScoreOutcomeSchema = z.enum(NON_SCORE_OUTCOMES)
