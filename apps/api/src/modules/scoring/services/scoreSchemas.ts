/**
 * Schemas for model-produced scores (P4.1).
 *
 * Validation here is the last line before a number reaches the database and, from there, a
 * ranking. Anything that does not satisfy these shapes is recorded as `SCORING_FAILED` rather
 * than coerced into something plausible.
 */
import { z } from 'zod'

export const evidenceItemSchema = z.object({
  path: z.string().min(1).max(1024),
  line_start: z.coerce.number().int().min(1),
  line_end: z.coerce.number().int().min(1),
  excerpt: z.string().min(1).max(8000),
})

/**
 * A criterion score.
 *
 * `score` and `insufficient_evidence` are deliberately separate fields rather than a single
 * nullable number: the distinction between "I looked and it is absent" (0) and "I could not
 * see enough to say" (insufficient) is the one E06-S01 acceptance 4 exists to protect, and
 * collapsing them into one field is how it gets lost.
 */
export const criterionScoreSchema = z.object({
  score: z.union([z.coerce.number().int().min(0).max(4), z.null()]),
  insufficient_evidence: z.boolean().default(false),
  confidence: z.coerce.number().int().min(0).max(100).default(0),
  anchor_matched: z.string().max(2000).nullable().default(null),
  rationale: z.string().min(1).max(8000),
  evidence: z.array(evidenceItemSchema).default([]),
  injection_noted: z.string().max(4000).nullable().default(null),
}).refine(
  (v) => v.insufficient_evidence || v.score !== null,
  { message: 'A score is required unless insufficient_evidence is true.' },
).refine(
  (v) => v.insufficient_evidence || v.evidence.length > 0,
  { message: 'A score must cite at least one piece of evidence (P0 constraint 2).' },
)

export type CriterionScoreOutput = z.infer<typeof criterionScoreSchema>

/** Principle adoption: a 0–4 maturity, because adoption is a journey rather than a switch. */
export const principleSchema = z.object({
  maturity: z.union([z.coerce.number().int().min(0).max(4), z.null()]),
  insufficient_evidence: z.boolean().default(false),
  confidence: z.coerce.number().int().min(0).max(100).default(0),
  rationale: z.string().min(1).max(8000),
  evidence: z.array(evidenceItemSchema).default([]),
}).refine((v) => v.insufficient_evidence || v.maturity !== null, {
  message: 'A maturity level is required unless insufficient_evidence is true.',
})

/** Standards compliance: a switch, because a standard is met or it is not. */
export const standardSchema = z.object({
  compliance: z.enum(['COMPLIANT', 'PARTIAL', 'NON_COMPLIANT', 'NOT_APPLICABLE']).nullable(),
  insufficient_evidence: z.boolean().default(false),
  confidence: z.coerce.number().int().min(0).max(100).default(0),
  rationale: z.string().min(1).max(8000),
  evidence: z.array(evidenceItemSchema).default([]),
}).refine((v) => v.insufficient_evidence || v.compliance !== null, {
  message: 'A compliance verdict is required unless insufficient_evidence is true.',
})

/**
 * The advisory originality signal (E06-S05).
 *
 * Deliberately shaped as observations plus a level, and the level carries the lowest weight in
 * the rubric. E07-S06 additionally refuses to let it be the sole reason a submission falls below
 * the cut line.
 */
export const originalitySchema = z.object({
  level: z.union([z.coerce.number().int().min(0).max(4), z.null()]),
  insufficient_evidence: z.boolean().default(false),
  confidence: z.coerce.number().int().min(0).max(100).default(0),
  rationale: z.string().min(1).max(8000),
  observations: z.array(z.string().max(1000)).default([]),
  evidence: z.array(evidenceItemSchema).default([]),
})
