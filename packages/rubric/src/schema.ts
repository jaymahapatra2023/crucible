/**
 * Runtime schemas for the rubric contract (E02-S03 acceptance 1).
 *
 * Shape only. Cross-field invariants — weights summing to 1.0, anchors being materially
 * distinct, `sourceRef` required for CHALLENGE_FIDELITY — live in `validate.ts`, because they
 * produce *reviewable* diagnostics rather than a parse failure.
 */
import { z } from 'zod'
import { DIMENSIONS, RUBRIC_STATUSES } from './types.js'

export const dimensionSchema = z.enum(DIMENSIONS)
export const rubricStatusSchema = z.enum(RUBRIC_STATUSES)

export const anchorsSchema = z.object({
  0: z.string().min(1, 'anchor 0 is required'),
  1: z.string().min(1, 'anchor 1 is required'),
  2: z.string().min(1, 'anchor 2 is required'),
  3: z.string().min(1, 'anchor 3 is required'),
  4: z.string().min(1, 'anchor 4 is required'),
})

export const criterionSchema = z.object({
  criterionId: z.string().min(1).max(64),
  dimension: dimensionSchema,
  name: z.string().min(3).max(200),
  description: z.string().min(1).max(4000),
  weight: z.number().min(0).max(1),
  evidenceSpec: z.string().min(1).max(2000),
  anchors: anchorsSchema,
  sourceRef: z.string().min(1).max(500).optional(),
  sortOrder: z.number().int().min(0),
  needsRewrite: z.boolean().optional(),
  gateNotes: z.array(z.string()).optional(),
})

export const dimensionWeightsSchema = z.object({
  CHALLENGE_FIDELITY: z.number().min(0).max(1),
  ENGINEERING_QUALITY: z.number().min(0).max(1),
  PRINCIPLES_STANDARDS: z.number().min(0).max(1),
  RUNS: z.number().min(0).max(1),
  ORIGINALITY: z.number().min(0).max(1),
})

export const rubricSchema = z.object({
  rubricId: z.string().min(1).max(64),
  challengeId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  status: rubricStatusSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  dimensionWeights: dimensionWeightsSchema,
  criteria: z.array(criterionSchema),
  generatedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  frozenAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
})

/**
 * What the criteria generator is asked to return (E02-S04).
 *
 * Note what is absent: **weight**. The generator proposes criteria; people set weights
 * (finding F4, invariant 2). Making that impossible to express in the output schema is stronger
 * than asking the model not to.
 */
/**
 * The wire shape uses snake_case because that is what the stored prompt asks the model for, and
 * the prompt is the contract with the model. The transform maps it to Crucible's camelCase
 * types, so neither side has to adopt the other's convention — and a rename on either side
 * fails here loudly rather than silently producing a criterion with a missing field.
 */
export const generatedCriterionSchema = z.object({
  name: z.string().min(3).max(200),
  description: z.string().min(20).max(4000),
  evidence_spec: z.string().min(20).max(2000),
  anchors: anchorsSchema,
  source_ref: z.string().min(1).max(500),
}).transform((c) => ({
  name: c.name,
  description: c.description,
  evidenceSpec: c.evidence_spec,
  anchors: c.anchors,
  sourceRef: c.source_ref,
}))

export const generatedCriteriaSchema = z.object({
  criteria: z.array(generatedCriterionSchema).min(1).max(20),
})

export type GeneratedCriterion = z.infer<typeof generatedCriterionSchema>
