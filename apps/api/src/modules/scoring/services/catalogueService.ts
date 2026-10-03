/**
 * Authoring the principles and standards an evaluation judges against (E12).
 *
 * Crucible shipped a seeded list with an adoption switch, on the assumption that a committee
 * picks from a catalogue. An organisation evaluating against its OWN guiding principles has to
 * be able to enter them — and a list it cannot extend is one it will keep in a document the
 * evaluation never reads.
 *
 * Two rules shape this module:
 *
 *  - **Authoring and adoption are separate acts.** Writing a principle down does not put it into
 *    the evaluation; adopting it does, and that is its own audited action. A new principle is
 *    therefore created INACTIVE, whoever creates it.
 *  - **A principle that has been scored against is not deleted.** Deleting it would orphan every
 *    assessment citing it and leave an appeal unanswerable. It is retired instead — withdrawn
 *    from future runs, still explaining past ones.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import {
  deletePrinciple, deleteStandard, insertPrinciple, insertStandard,
  principleUsage, setPrincipleActive, setStandardActive, standardUsage,
  updatePrinciple, updateStandard,
  type PrincipleInput, type PrincipleRow, type StandardInput, type StandardRow,
} from '../db/principlesDb.js'

const log = createLogger('scoring', 'catalogue')

export async function createPrinciple(
  input: PrincipleInput, actor: string,
): Promise<PrincipleRow> {
  assertAnchorsDistinct(input.anchors)

  let row: PrincipleRow
  try {
    row = await insertPrinciple(input, actor)
  } catch (err) {
    throw translateDuplicate(err, 'principle', input.code)
  }

  await recordAudit({
    actor, action: 'scoring.principle_created',
    subjectType: 'arch_principle', subjectId: String(row.principle_id),
    payload: { code: input.code, pillar: input.pillar, name: input.name },
  })
  log.info('principle authored', { code: input.code, pillar: input.pillar })
  return row
}

export async function editPrinciple(
  principleId: number, input: PrincipleInput, actor: string,
): Promise<PrincipleRow> {
  assertAnchorsDistinct(input.anchors)

  // An edit to a principle already scored against changes the standard retrospectively: past
  // assessments cite wording that no longer exists. Allowed, because a typo must be fixable,
  // and recorded loudly so an appeal can see it happened.
  const used = await principleUsage(principleId)

  let row: PrincipleRow | null
  try {
    row = await updatePrinciple(principleId, input)
  } catch (err) {
    throw translateDuplicate(err, 'principle', input.code)
  }
  if (!row) throw new AppError('NOT_FOUND', `Principle ${principleId} was not found.`)

  await recordAudit({
    actor, action: 'scoring.principle_edited',
    subjectType: 'arch_principle', subjectId: String(principleId),
    payload: { code: input.code, name: input.name, assessmentsAffected: used },
  })
  if (used > 0) {
    log.warn('a principle already scored against was edited', {
      principleId, code: input.code, assessments: used,
    })
  }
  return row
}

/**
 * Remove a principle, or retire it when it has been used.
 *
 * Retiring rather than deleting is not squeamishness: `principle_assessment` rows reference it,
 * and a packet that cannot name the principle a team was assessed against answers nothing.
 */
export async function retirePrinciple(
  principleId: number, actor: string,
): Promise<{ deleted: boolean; reason: string }> {
  const used = await principleUsage(principleId)

  if (used > 0) {
    const row = await setPrincipleActive(principleId, false)
    if (!row) throw new AppError('NOT_FOUND', `Principle ${principleId} was not found.`)

    await recordAudit({
      actor, action: 'scoring.principle_retired',
      subjectType: 'arch_principle', subjectId: String(principleId),
      payload: { code: row.code, assessments: used },
    })
    return {
      deleted: false,
      reason:
        `This principle has been assessed against ${used} time(s), so it was withdrawn from ` +
        `future runs rather than deleted. Past assessments still name it, which is what makes ` +
        `them answerable.`,
    }
  }

  if (!(await deletePrinciple(principleId))) {
    throw new AppError('NOT_FOUND', `Principle ${principleId} was not found.`)
  }
  await recordAudit({
    actor, action: 'scoring.principle_deleted',
    subjectType: 'arch_principle', subjectId: String(principleId), payload: {},
  })
  return { deleted: true, reason: 'Never assessed against, so removed outright.' }
}

export async function createStandard(
  input: StandardInput, actor: string,
): Promise<StandardRow> {
  let row: StandardRow
  try {
    row = await insertStandard(input, actor)
  } catch (err) {
    throw translateDuplicate(err, 'standard', input.code)
  }

  await recordAudit({
    actor, action: 'scoring.standard_created',
    subjectType: 'it_standard', subjectId: String(row.standard_id),
    payload: { code: input.code, category: input.category, mandatory: input.mandatory },
  })
  log.info('standard authored', { code: input.code, category: input.category })
  return row
}

export async function editStandard(
  standardId: number, input: StandardInput, actor: string,
): Promise<StandardRow> {
  const used = await standardUsage(standardId)

  let row: StandardRow | null
  try {
    row = await updateStandard(standardId, input)
  } catch (err) {
    throw translateDuplicate(err, 'standard', input.code)
  }
  if (!row) throw new AppError('NOT_FOUND', `Standard ${standardId} was not found.`)

  await recordAudit({
    actor, action: 'scoring.standard_edited',
    subjectType: 'it_standard', subjectId: String(standardId),
    payload: { code: input.code, name: input.name, assessmentsAffected: used },
  })
  return row
}

export async function retireStandard(
  standardId: number, actor: string,
): Promise<{ deleted: boolean; reason: string }> {
  const used = await standardUsage(standardId)

  if (used > 0) {
    const row = await setStandardActive(standardId, false)
    if (!row) throw new AppError('NOT_FOUND', `Standard ${standardId} was not found.`)

    await recordAudit({
      actor, action: 'scoring.standard_retired',
      subjectType: 'it_standard', subjectId: String(standardId),
      payload: { code: row.code, assessments: used },
    })
    return {
      deleted: false,
      reason:
        `This standard has been assessed against ${used} time(s), so it was withdrawn from ` +
        `future runs rather than deleted.`,
    }
  }

  if (!(await deleteStandard(standardId))) {
    throw new AppError('NOT_FOUND', `Standard ${standardId} was not found.`)
  }
  await recordAudit({
    actor, action: 'scoring.standard_deleted',
    subjectType: 'it_standard', subjectId: String(standardId), payload: {},
  })
  return { deleted: true, reason: 'Never assessed against, so removed outright.' }
}

/**
 * Anchors must say different things (E02-S05 acceptance 3).
 *
 * Two adjacent anchors with the same wording make the levels between them unscoreable: a scorer
 * asked to choose between "logging exists" and "logging exists" will pick one at random, and the
 * maturity score becomes noise with a number attached.
 */
function assertAnchorsDistinct(anchors: readonly string[]): void {
  const normalised = anchors.map((a) => a.trim().toLowerCase().replace(/\s+/g, ' '))
  for (let i = 1; i < normalised.length; i++) {
    if (normalised[i] === normalised[i - 1]) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Levels ${i - 1} and ${i} have the same wording. Each level must describe something ` +
          `different, or a scorer cannot choose between them and the maturity score is noise.`,
      )
    }
  }
  if (new Set(normalised).size !== normalised.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Two levels share the same wording. Each of the five must describe a different state.',
    )
  }
}

function translateDuplicate(err: unknown, what: string, code: string): unknown {
  return String(err).includes('already exists') || String(err).includes('duplicate key')
    ? new AppError(
        'ALREADY_EXISTS',
        `A ${what} with the code '${code}' already exists. Codes identify it in assessments ` +
          `and exports, so they have to be unique.`)
    : err
}
