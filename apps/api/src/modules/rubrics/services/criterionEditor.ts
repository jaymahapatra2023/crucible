/**
 * Hand editing of criteria (E02-S06 acceptance 1).
 *
 * Criteria can be edited, reordered, removed and added by hand. The committee's judgement is the
 * point of this story — the generator produces a draft to react to, not a rubric to accept.
 */
import type { Criterion, Dimension } from '@crucible/rubric'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import {
  deleteCriterion, insertCriterion, selectCriteria, updateCriterion, type CriterionInput,
} from '../db/rubricDb.js'
import { loadRubric } from './rubricService.js'

const log = createLogger('rubrics', 'criterionEditor')

async function assertEditable(rubricId: number): Promise<void> {
  const rubric = await loadRubric(rubricId)
  if (rubric.status === 'FROZEN' || rubric.status === 'SUPERSEDED') {
    throw new AppError(
      'IMMUTABLE_RESOURCE',
      `Rubric ${rubricId} is ${rubric.status}; create a new version to change its criteria.`,
    )
  }
}

export interface AddCriterionInput {
  rubricId: number
  dimension: Dimension
  name: string
  description: string
  weight: number
  evidenceSpec: string
  anchors: Record<0 | 1 | 2 | 3 | 4, string>
  sourceRef?: string
  actor: string
}

export async function addCriterion(input: AddCriterionInput): Promise<Criterion> {
  await assertEditable(input.rubricId)
  const existing = await selectCriteria(input.rubricId)
  const sortOrder = Math.max(0, ...existing.map((c) => c.sortOrder)) + 1

  const criterion = await insertCriterion(input.rubricId, {
    dimension: input.dimension,
    name: input.name,
    description: input.description,
    weight: input.weight,
    evidenceSpec: input.evidenceSpec,
    anchors: input.anchors,
    sourceRef: input.sourceRef ?? null,
    sortOrder,
  })

  await recordAudit({
    actor: input.actor, action: 'rubric.edited', subjectType: 'rubric',
    subjectId: String(input.rubricId),
    payload: { change: 'criterion_added', criterionId: criterion.criterionId, name: input.name },
  })
  return criterion
}

export interface EditCriterionInput {
  rubricId: number
  criterionId: number
  patch: Partial<Omit<CriterionInput, 'dimension'>>
  actor: string
}

export async function editCriterion(input: EditCriterionInput): Promise<Criterion> {
  await assertEditable(input.rubricId)
  const updated = await updateCriterion(input.criterionId, input.patch)
  if (!updated) throw new AppError('NOT_FOUND', `Criterion ${input.criterionId} was not found.`)

  await recordAudit({
    actor: input.actor, action: 'rubric.edited', subjectType: 'rubric',
    subjectId: String(input.rubricId),
    payload: {
      change: 'criterion_edited',
      criterionId: String(input.criterionId),
      fields: Object.keys(input.patch),
    },
  })
  log.info('criterion edited', { criterionId: input.criterionId, fields: Object.keys(input.patch) })
  return updated
}

export async function removeCriterion(
  rubricId: number, criterionId: number, actor: string,
): Promise<void> {
  await assertEditable(rubricId)
  const removed = await deleteCriterion(criterionId)
  if (!removed) throw new AppError('NOT_FOUND', `Criterion ${criterionId} was not found.`)

  await recordAudit({
    actor, action: 'rubric.edited', subjectType: 'rubric', subjectId: String(rubricId),
    payload: { change: 'criterion_removed', criterionId: String(criterionId) },
  })
}

/** Reorder criteria. Display order only — it does not affect the content hash or any score. */
export async function reorderCriteria(
  rubricId: number, orderedIds: readonly number[], actor: string,
): Promise<Criterion[]> {
  await assertEditable(rubricId)
  const existing = await selectCriteria(rubricId)
  const known = new Set(existing.map((c) => c.criterionId))

  for (const id of orderedIds) {
    if (!known.has(String(id))) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Criterion ${id} does not belong to rubric ${rubricId}.`,
      )
    }
  }
  if (orderedIds.length !== existing.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Reordering must list every criterion: got ${orderedIds.length}, rubric has ${existing.length}.`,
    )
  }

  for (let i = 0; i < orderedIds.length; i++) {
    await updateCriterion(orderedIds[i] as number, { sortOrder: i })
  }
  await recordAudit({
    actor, action: 'rubric.edited', subjectType: 'rubric', subjectId: String(rubricId),
    payload: { change: 'criteria_reordered' },
  })
  return selectCriteria(rubricId)
}

/**
 * Set criterion weights within one dimension.
 *
 * Deliberately takes the whole dimension at once. Setting weights one at a time guarantees the
 * rubric passes through invalid intermediate states, and makes "does this dimension sum to 1.0"
 * — the thing E02-S06 acceptance 2 blocks approval on — impossible to answer during the edit.
 */
export async function setCriterionWeights(input: {
  rubricId: number
  dimension: Dimension
  weights: Record<string, number>
  actor: string
}): Promise<Criterion[]> {
  await assertEditable(input.rubricId)
  const existing = await selectCriteria(input.rubricId)
  const inDimension = existing.filter((c) => c.dimension === input.dimension)

  const given = Object.keys(input.weights)
  const expected = inDimension.map((c) => c.criterionId)
  const missing = expected.filter((id) => !given.includes(id))
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Weights must be set for every criterion in ${input.dimension} at once. ` +
        `Missing: ${missing.join(', ')}.`,
    )
  }

  for (const [criterionId, weight] of Object.entries(input.weights)) {
    if (!expected.includes(criterionId)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Criterion ${criterionId} is not in dimension ${input.dimension}.`,
      )
    }
    await updateCriterion(Number(criterionId), { weight })
  }

  await recordAudit({
    actor: input.actor, action: 'rubric.edited', subjectType: 'rubric',
    subjectId: String(input.rubricId),
    payload: { change: 'weights_set', dimension: input.dimension, weights: input.weights },
  })
  return selectCriteria(input.rubricId)
}
