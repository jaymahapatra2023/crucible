/**
 * Criterion editing endpoints (E02-S06 acceptance 1 and 2).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { DIMENSIONS } from '@crucible/rubric'
import { body, params } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import {
  addCriterion, editCriterion, removeCriterion, reorderCriteria, setCriterionWeights,
} from '../services/criterionEditor.js'

const rubricParams = z.object({ id: z.coerce.number().int().min(1) })
const criterionParams = z.object({
  id: z.coerce.number().int().min(1),
  criterionId: z.coerce.number().int().min(1),
})

const anchorsSchema = z.object({
  0: z.string().min(1).max(2000),
  1: z.string().min(1).max(2000),
  2: z.string().min(1).max(2000),
  3: z.string().min(1).max(2000),
  4: z.string().min(1).max(2000),
})

const addBody = z.object({
  dimension: z.enum(DIMENSIONS),
  name: z.string().min(3).max(200),
  description: z.string().max(4000).default(''),
  weight: z.number().min(0).max(1),
  evidenceSpec: z.string().min(1).max(2000),
  anchors: anchorsSchema,
  sourceRef: z.string().min(1).max(500).optional(),
})

const editBody = z.object({
  name: z.string().min(3).max(200).optional(),
  description: z.string().max(4000).optional(),
  weight: z.number().min(0).max(1).optional(),
  evidenceSpec: z.string().min(1).max(2000).optional(),
  anchors: anchorsSchema.optional(),
  sourceRef: z.string().min(1).max(500).optional(),
  /** Clearing the gate flag is an explicit act: the reviewer is saying they fixed it. */
  needsRewrite: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided.' })

const reorderBody = z.object({
  order: z.array(z.coerce.number().int().min(1)).min(1),
})

const weightsBody = z.object({
  dimension: z.enum(DIMENSIONS),
  /** Criterion id → weight. The whole dimension at once; see setCriterionWeights. */
  weights: z.record(z.string(), z.number().min(0).max(1)),
})

export async function registerCriterionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/rubrics/:id/criteria', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const { id } = params(req, rubricParams)
    const input = body(req, addBody)
    const criterion = await addCriterion({
      rubricId: id,
      dimension: input.dimension,
      name: input.name,
      description: input.description,
      weight: input.weight,
      evidenceSpec: input.evidenceSpec,
      anchors: input.anchors,
      ...(input.sourceRef !== undefined && { sourceRef: input.sourceRef }),
      actor: principalOf(req).email,
    })
    reply.status(201)
    return ok(criterion)
  })

  app.patch('/api/v1/rubrics/:id/criteria/:criterionId',
    { preHandler: requireRole('organiser') }, async (req) => {
      const { id, criterionId } = params(req, criterionParams)
      const patch = body(req, editBody)
      return ok(await editCriterion({
        rubricId: id,
        criterionId,
        patch: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.weight !== undefined && { weight: patch.weight }),
          ...(patch.evidenceSpec !== undefined && { evidenceSpec: patch.evidenceSpec }),
          ...(patch.anchors !== undefined && { anchors: patch.anchors }),
          ...(patch.sourceRef !== undefined && { sourceRef: patch.sourceRef }),
          ...(patch.needsRewrite !== undefined && { needsRewrite: patch.needsRewrite }),
        },
        actor: principalOf(req).email,
      }))
    })

  app.delete('/api/v1/rubrics/:id/criteria/:criterionId',
    { preHandler: requireRole('organiser') }, async (req, reply) => {
      const { id, criterionId } = params(req, criterionParams)
      await removeCriterion(id, criterionId, principalOf(req).email)
      reply.status(204)
      return null
    })

  app.put('/api/v1/rubrics/:id/criteria/order',
    { preHandler: requireRole('organiser') }, async (req) => {
      const { id } = params(req, rubricParams)
      const { order } = body(req, reorderBody)
      return ok(await reorderCriteria(id, order, principalOf(req).email))
    })

  /** Weights are set by a human, one whole dimension at a time (E02-S06 acceptance 2). */
  app.put('/api/v1/rubrics/:id/criteria/weights',
    { preHandler: requireRole('organiser') }, async (req) => {
      const { id } = params(req, rubricParams)
      const input = body(req, weightsBody)
      return ok(await setCriterionWeights({
        rubricId: id,
        dimension: input.dimension,
        weights: input.weights,
        actor: principalOf(req).email,
      }))
    })
}
