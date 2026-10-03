/**
 * Rubric lifecycle: create a version, edit it, weight it (E02-S06), approve and freeze it
 * (E02-S07).
 *
 * The state machine is deliberately narrow:
 *
 *   DRAFT → IN_REVIEW → APPROVED → FROZEN → (SUPERSEDED, when a newer version freezes)
 *
 * Every transition out of FROZEN other than SUPERSEDED is refused by the database trigger in
 * migration 008, so this service is the convenient path rather than the only guard (P8.5).
 */
import {
  DEFAULT_DIMENSION_WEIGHTS, hashRubric, validateRubric,
  type Criterion, type DimensionWeights, type Rubric, type ValidationReport,
} from '@crucible/rubric'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { tx } from '../../../db/pool.js'
import {
  insertCriterion, insertRubric, selectCriteria, selectFrozenRubricRow, selectLatestVersion,
  selectRubricRow, selectRubricsForChallenge, updateDimensionWeights, updateRubricStatus,
  toRubric, type CriterionInput, type RubricRow,
} from '../db/rubricDb.js'

const log = createLogger('rubrics', 'rubricService')

export async function loadRubric(rubricId: number): Promise<Rubric> {
  const row = await selectRubricRow(rubricId)
  if (!row) throw new AppError('NOT_FOUND', `Rubric ${rubricId} was not found.`)
  return toRubric(row, await selectCriteria(rubricId))
}

async function hydrate(row: RubricRow): Promise<Rubric> {
  return toRubric(row, await selectCriteria(row.rubric_id))
}

export async function listRubrics(challengeId: number): Promise<Rubric[]> {
  const rows = await selectRubricsForChallenge(challengeId)
  return Promise.all(rows.map(hydrate))
}

export async function frozenRubric(challengeId: number): Promise<Rubric | null> {
  const row = await selectFrozenRubricRow(challengeId)
  return row ? hydrate(row) : null
}

/**
 * Create the next version for a challenge.
 *
 * Always a new version, never an edit of an existing one (E02-S04 acceptance 5). Versioning is
 * the mechanism by which "what standard was this team judged by" stays answerable.
 */
export async function createVersion(input: {
  challengeId: number
  criteria: CriterionInput[]
  dimensionWeights?: DimensionWeights
  actor: string
  supersedes?: number | null
}): Promise<Rubric> {
  const version = (await selectLatestVersion(input.challengeId)) + 1

  const rubric = await tx(async (client) => {
    const row = await insertRubric({
      challengeId: input.challengeId,
      version,
      dimensionWeights: input.dimensionWeights ?? { ...DEFAULT_DIMENSION_WEIGHTS },
      generatedBy: input.actor,
      previousId: input.supersedes ?? null,
    }, client)

    for (const criterion of input.criteria) {
      await insertCriterion(row.rubric_id, criterion, client)
    }
    return row
  })

  await recordAudit({
    actor: input.actor,
    action: 'rubric.generated',
    subjectType: 'rubric',
    subjectId: String(rubric.rubric_id),
    payload: { challengeId: input.challengeId, version, criteria: input.criteria.length },
  })
  log.info('rubric version created', {
    rubricId: rubric.rubric_id, challengeId: input.challengeId, version,
  })
  return hydrate(rubric)
}

/** Guard every edit path: a rubric past APPROVED is not editable (E02-S06). */
async function assertEditable(rubricId: number): Promise<Rubric> {
  const rubric = await loadRubric(rubricId)
  if (rubric.status === 'FROZEN' || rubric.status === 'SUPERSEDED') {
    throw new AppError(
      'IMMUTABLE_RESOURCE',
      `Rubric ${rubricId} is ${rubric.status} and cannot be edited. Create a new version ` +
        `instead — a frozen rubric is the record of what teams were judged by.`,
    )
  }
  return rubric
}

export async function setDimensionWeights(
  rubricId: number, weights: DimensionWeights, actor: string,
): Promise<Rubric> {
  await assertEditable(rubricId)
  const row = await updateDimensionWeights(rubricId, weights)
  if (!row) throw new AppError('NOT_FOUND', `Rubric ${rubricId} was not found.`)
  await recordAudit({
    actor, action: 'rubric.edited', subjectType: 'rubric', subjectId: String(rubricId),
    payload: { change: 'dimension_weights', weights },
  })
  return hydrate(row)
}

export interface ApprovalReadiness {
  report: ValidationReport
  /** Warnings a reviewer must explicitly acknowledge before approval (E02-S06 acceptance 4). */
  unacknowledgedWarnings: string[]
  canApprove: boolean
}

/**
 * Whether a rubric may be approved.
 *
 * Blocks on any validation error — which includes "weights do not sum to 1.0 per dimension",
 * the specific bar E02-S06 acceptance 2 sets — and requires every warning to be acknowledged by
 * code, so quality-gate concerns cannot be approved past without being seen.
 */
export async function approvalReadiness(
  rubricId: number, acknowledgedCodes: readonly string[] = [],
): Promise<ApprovalReadiness> {
  const rubric = await loadRubric(rubricId)
  const report = validateRubric(rubric)
  const acknowledged = new Set(acknowledgedCodes)
  const unacknowledged = report.warnings
    .map((w) => w.code)
    .filter((code) => !acknowledged.has(code))

  return {
    report,
    unacknowledgedWarnings: [...new Set(unacknowledged)],
    canApprove: report.valid && unacknowledged.length === 0,
  }
}

export async function approveRubric(
  rubricId: number, actor: string, acknowledgedWarnings: readonly string[] = [],
): Promise<Rubric> {
  await assertEditable(rubricId)
  const readiness = await approvalReadiness(rubricId, acknowledgedWarnings)

  if (!readiness.report.valid) {
    throw new AppError(
      'UNPROCESSABLE',
      `Rubric ${rubricId} cannot be approved: ` +
        readiness.report.errors.map((e) => e.message).join(' '),
      { details: { errors: readiness.report.errors } },
    )
  }
  if (readiness.unacknowledgedWarnings.length > 0) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Rubric ${rubricId} has ${readiness.unacknowledgedWarnings.length} warning(s) that must be ` +
        `acknowledged before approval: ${readiness.unacknowledgedWarnings.join(', ')}.`,
      { details: { warnings: readiness.report.warnings } },
    )
  }

  const row = await updateRubricStatus({ rubricId, status: 'APPROVED', actor })
  if (!row) throw new AppError('NOT_FOUND', `Rubric ${rubricId} was not found.`)
  await recordAudit({
    actor, action: 'rubric.approved', subjectType: 'rubric', subjectId: String(rubricId),
    payload: { acknowledgedWarnings },
  })
  log.info('rubric approved', { rubricId, actor })
  return hydrate(row)
}

/**
 * Freeze an approved rubric (E02-S07).
 *
 * The content hash is computed here and stored, so every score can name the exact standard it
 * ran under. Any previously frozen rubric for the same challenge is marked SUPERSEDED in the
 * same transaction — the partial-unique index permits only one frozen rubric per challenge, so
 * doing this in two steps would leave a window where freezing fails for a confusing reason.
 */
export async function freezeRubric(rubricId: number, actor: string): Promise<Rubric> {
  const rubric = await loadRubric(rubricId)
  if (rubric.status !== 'APPROVED') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Rubric ${rubricId} is ${rubric.status}. Only an APPROVED rubric can be frozen.`,
    )
  }

  const report = validateRubric(rubric)
  if (!report.valid) {
    throw new AppError(
      'UNPROCESSABLE',
      `Rubric ${rubricId} no longer validates and cannot be frozen: ` +
        report.errors.map((e) => e.message).join(' '),
    )
  }

  const contentHash = hashRubric(rubric.criteria, rubric.dimensionWeights)
  const challengeId = Number(rubric.challengeId)

  const frozen = await tx(async (client) => {
    const previous = await selectFrozenRubricRow(challengeId)
    if (previous && previous.rubric_id !== rubricId) {
      await updateRubricStatus({ rubricId: previous.rubric_id, status: 'SUPERSEDED' }, client)
    }
    return updateRubricStatus({ rubricId, status: 'FROZEN', contentHash, freeze: true }, client)
  })

  if (!frozen) throw new AppError('NOT_FOUND', `Rubric ${rubricId} was not found.`)
  await recordAudit({
    actor, action: 'rubric.frozen', subjectType: 'rubric', subjectId: String(rubricId),
    payload: { contentHash, version: rubric.version, challengeId },
  })
  log.info('rubric frozen', { rubricId, contentHash, version: rubric.version })
  return hydrate(frozen)
}

export { type Criterion }
