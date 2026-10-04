/**
 * Participants confirming their own details from a public page (migration 104).
 *
 * The problem this solves: people who signed up on paper are on the roster under a placeholder
 * address and sometimes a misread name. They need to say "that is me, here is my real email"
 * without queueing at a desk.
 *
 * Two rules shape everything here.
 *
 * **Nothing is revealed.** The reply is the same sentence whether the name is on the list, is
 * not, or is ambiguous. A public page that answered differently would be a way to find out who
 * is at the event, name by name, and the registration form was deliberately built without a
 * directory for the same reason (II.1).
 *
 * **Nothing is applied.** A claim is recorded for an organiser to confirm. Rewriting an address
 * on request would put the claimant on that person's team emails, including the one carrying
 * their submission code — which is the team's identity (E17-S01). One click by a human who can
 * see the before and after costs seconds and closes that off entirely.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { insertParticipant, updateParticipant } from '../db/rosterDb.js'
import {
  decideCorrection, insertCorrection, selectByNormalisedName, selectCorrection,
  type Correction,
} from '../db/correctionDb.js'

const log = createLogger('roster', 'corrections')

/**
 * One sentence, always the same.
 *
 * Deliberately says "if" rather than confirming anything. It has to read as a genuine answer to
 * the person who IS on the list, while telling somebody fishing for names precisely nothing.
 */
const ACKNOWLEDGED =
  'Thank you. If that name is on the participant list, an organiser will confirm the change '
  + 'shortly. There is nothing else for you to do — you do not need to wait here.'

export interface ClaimOutcome {
  /** Always true. The caller learns nothing from this; it exists so the page can render. */
  received: boolean
  message: string
}

export async function submitCorrection(input: {
  fullName: string
  email: string
}): Promise<ClaimOutcome> {
  const fullName = input.fullName.trim()
  const email = input.email.trim()

  // Resolved privately. A null match is recorded exactly like a hit, because a walk-in nobody
  // wrote down is a real case and an organiser can add them from the queue.
  const match = await selectByNormalisedName(fullName)

  const correctionId = await insertCorrection({
    claimedName: fullName, claimedEmail: email,
    participantId: match?.participantId ?? null,
    previousName: match?.fullName ?? null,
    previousEmail: match?.email ?? null,
  })

  // No name and no address in the log line: this is a public endpoint and the log is not the
  // place personal data accumulates (P8.3).
  log.info('participant correction claimed', { correctionId, matched: match !== null })

  return { received: true, message: ACKNOWLEDGED }
}

export interface DecisionOutcome {
  correctionId: number
  status: 'APPLIED' | 'REJECTED'
  /** CORRECTED an existing row, or ADDED a person who was not on the list. */
  effect: 'CORRECTED' | 'ADDED' | 'NONE'
  participantId: number | null
  /** What actually changed, for the organiser who pressed the button. */
  detail: string
}

/**
 * Apply a claim to the roster, or reject it.
 *
 * Two shapes, one button. A claim that matched somebody CORRECTS that row: identity is the row
 * and not the address (E17-S01), so a member already on a team stays on it and their team's
 * notifications follow the corrected address from here on. A claim that matched nobody ADDS
 * them, because somebody standing in the room saying who they are is exactly the walk-in the
 * paper sign-up sheet was for, and refusing would send them back to the desk.
 */
export async function decide(input: {
  correctionId: number
  approve: boolean
  actor: string
}): Promise<DecisionOutcome> {
  const correction = await selectCorrection(input.correctionId)
  if (!correction) {
    throw new AppError('NOT_FOUND', `Correction ${input.correctionId} was not found.`)
  }
  if (correction.status !== 'PENDING') {
    throw new AppError('PRECONDITION_FAILED',
      `That correction was already ${correction.status.toLowerCase()}.`)
  }

  const won = await decideCorrection({
    correctionId: input.correctionId,
    status: input.approve ? 'APPLIED' : 'REJECTED',
    actor: input.actor,
  })
  if (!won) {
    throw new AppError('PRECONDITION_FAILED',
      'Somebody decided that correction a moment ago. Reload the queue.')
  }

  if (!input.approve) {
    await audit(correction, 'rejected', input.actor)
    return {
      correctionId: input.correctionId, status: 'REJECTED', effect: 'NONE',
      participantId: correction.participantId, detail: 'Left as it was.',
    }
  }

  if (correction.participantId === null) {
    const added = await insertParticipant({
      fullName: correction.claimedName, email: correction.claimedEmail,
      organisation: 'Added at the desk', phone: null, notes: '', createdBy: input.actor,
    })
    await audit({ ...correction, participantId: added.participantId }, 'applied', input.actor)
    return {
      correctionId: input.correctionId, status: 'APPLIED', effect: 'ADDED',
      participantId: added.participantId,
      detail: `${correction.claimedName} was not on the list and has been added.`,
    }
  }

  await updateParticipant({
    participantId: correction.participantId,
    fullName: correction.claimedName,
    email: correction.claimedEmail,
  })
  await audit(correction, 'applied', input.actor)

  return {
    correctionId: input.correctionId, status: 'APPLIED', effect: 'CORRECTED',
    participantId: correction.participantId,
    detail: `${correction.currentName ?? 'that participant'} is now `
      + `${correction.claimedName}, reachable at the address they gave.`,
  }
}

/** Ids and the decision, never an address (P8.3). */
async function audit(c: Correction, what: string, actor: string): Promise<void> {
  await recordAudit({
    actor, action: `roster.correction_${what}`, subjectType: 'participant',
    subjectId: String(c.participantId ?? 'unmatched'),
    payload: { correctionId: c.correctionId, matched: c.matched, onATeam: c.onATeam },
  })
}
