/**
 * Human decisions on the shortlist (E08-S04, E08-S05).
 *
 * This is the module where P0's first constraint is actually honoured. Everything upstream
 * ranks, measures and flags; nothing upstream decides. A decision is written here, by a named
 * person, with a reason they typed, and it is what the export and any appeal are answered from.
 *
 * Two rules are enforced by the database rather than here, on purpose: a reason is mandatory,
 * and a finalised shortlist is immutable. Both are the kind of rule that a future caller
 * bypasses by accident, and both are the kind whose absence is only discovered during an appeal.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { selectScoreRun } from '../../scoring/db/scoringDb.js'
import { selectRanking, selectSnapshot } from '../../scoring/db/rankingDb.js'
import {
  decisionCounts, finaliseShortlist, reopenShortlist, selectDecisionHistory, selectDecisions,
  selectShortlist,
  unresolvedInBand, recordDecision, upsertShortlist,
  type BlockingItem, type DecisionRow, type ShortlistRow,
} from '../db/shortlistDb.js'

const log = createLogger('review', 'shortlistService')

export type Decision = 'SHORTLIST' | 'EXCLUDE' | 'HOLD'

export interface ShortlistState {
  shortlist: ShortlistRow
  decisions: DecisionRow[]
  counts: Record<string, number>
  /**
   * Cut-band submissions that block finalisation: undecided, held, or carrying an unreviewed
   * caveat. All three are states the shortlist must not be locked in.
   */
  blocking: BlockingItem[]
}

export async function openShortlist(
  runIndexId: number, actor: string, name = '',
): Promise<ShortlistRow> {
  const run = await selectScoreRun(runIndexId)
  if (!run) throw new AppError('NOT_FOUND', `Scoring run ${runIndexId} was not found.`)

  if (!(await selectSnapshot(runIndexId))) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Scoring run ${runIndexId} has no stored ranking. A shortlist is drawn from a ranking; ` +
        `opening one before the ranking exists would mean deciding on nothing.`,
    )
  }

  return upsertShortlist({ runIndexId, name, createdBy: actor })
}

export async function shortlistState(runIndexId: number): Promise<ShortlistState> {
  const shortlist = await selectShortlist(runIndexId)
  if (!shortlist) {
    throw new AppError(
      'NOT_FOUND',
      `Scoring run ${runIndexId} has no shortlist yet.`,
    )
  }

  const [decisions, counts, blocking] = await Promise.all([
    selectDecisions(runIndexId),
    decisionCounts(runIndexId),
    unresolvedInBand(runIndexId),
  ])

  return { shortlist, decisions, counts, blocking }
}

/**
 * Record a decision (acceptance 1).
 *
 * The rank at the time is stored with it. Without that, a later re-ranking makes every recorded
 * decision look arbitrary — "why did they exclude the team ranked 12th" has a different answer
 * when that team was ranked 31st when the decision was taken.
 */
export async function decide(input: {
  runIndexId: number
  submissionId: number
  decision: Decision
  reason: string
  actor: string
}): Promise<DecisionRow> {
  const shortlist = await selectShortlist(input.runIndexId)
  if (!shortlist) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Scoring run ${input.runIndexId} has no shortlist. Open one before recording decisions.`,
    )
  }

  const ranked = await selectRanking(input.runIndexId)
  const entry = ranked.find((r) => r.submission_id === input.submissionId)
  if (!entry) {
    throw new AppError(
      'NOT_FOUND',
      `Submission ${input.submissionId} is not in the ranking for run ${input.runIndexId}. A ` +
        `decision about a team the ranking does not contain could not be explained later.`,
    )
  }

  const previous = (await selectDecisions(input.runIndexId))
    .find((d) => d.submission_id === input.submissionId) ?? null

  try {
    await recordDecision({
      shortlistId: shortlist.shortlist_id,
      submissionId: input.submissionId,
      decision: input.decision,
      reason: input.reason,
      actor: input.actor,
      rankAtDecision: entry.rank_global,
    })
  } catch (err) {
    throw translateDecisionError(err, shortlist)
  }

  await recordAudit({
    actor: input.actor,
    action: 'review.decision_recorded',
    subjectType: 'submission',
    subjectId: String(input.submissionId),
    payload: {
      runIndexId: input.runIndexId,
      decision: input.decision,
      reason: input.reason,
      rankAtDecision: entry.rank_global,
      composite: entry.composite,
      // What it replaced, so a move reads as a move in the audit trail rather than as a second
      // unrelated decision about the same team.
      supersedes: previous === null ? null : {
        decision: previous.decision, decidedBy: previous.decided_by,
      },
    },
  })

  log.info('decision recorded', {
    runIndexId: input.runIndexId, submissionId: input.submissionId,
    decision: input.decision, rank: entry.rank_global,
    supersedes: previous?.decision ?? null,
  })

  const decisions = await selectDecisions(input.runIndexId)
  return decisions.find((d) => d.submission_id === input.submissionId)!
}

function translateDecisionError(err: unknown, shortlist: ShortlistRow): AppError {
  const text = String(err)

  if (text.includes('is FINAL')) {
    return new AppError(
      'CONFLICT',
      `Shortlist ${shortlist.shortlist_id} is final and its decisions are immutable. Reopen it ` +
        `if the outcome genuinely needs to change — that is a recorded act, which is the point.`,
    )
  }

  if (text.includes('shortlist_decision_reason_check') || text.includes('reason')) {
    return new AppError(
      'VALIDATION_FAILED',
      'A decision needs a reason of at least ten characters. The shortlist is what an appeal is ' +
        'answered from, and "why was this team excluded" has to have an answer written by a ' +
        'person at the time.',
    )
  }

  return err instanceof AppError ? err : new AppError('INTERNAL_ERROR', text)
}

/**
 * Lock the shortlist (acceptance 1), refusing while the cut band is unresolved (acceptance 3).
 *
 * The refusal is the substance of this function. The band is where a person's judgement changes
 * the outcome; finalising with those undecided would lock in a result that nobody looked at, and
 * would do it silently.
 */
export async function finalise(input: {
  runIndexId: number
  actor: string
}): Promise<ShortlistRow> {
  const state = await shortlistState(input.runIndexId)

  if (state.shortlist.status === 'FINAL') {
    throw new AppError(
      'CONFLICT',
      `Shortlist ${state.shortlist.shortlist_id} is already final.`,
    )
  }

  if (state.blocking.length > 0) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `${state.blocking.length} submission(s) at the cut line are unresolved. ` +
        `${describeBlocking(state.blocking)} These are the submissions where a person's ` +
        `judgement changes the outcome, so the shortlist cannot be locked until each has been ` +
        `decided and every caveat raised about it answered.`,
      { details: { blocking: state.blocking } },
    )
  }

  const run = await selectScoreRun(input.runIndexId)
  const finalised = await finaliseShortlist({
    shortlistId: state.shortlist.shortlist_id,
    actor: input.actor,
    // The standard in force, recorded with the outcome (acceptance 1).
    rubricVersions: run?.rubric_versions ?? {},
  })

  if (!finalised) {
    throw new AppError('CONFLICT', 'The shortlist changed while it was being finalised.')
  }

  await recordAudit({
    actor: input.actor,
    action: 'review.shortlist_finalised',
    subjectType: 'shortlist',
    subjectId: String(finalised.shortlist_id),
    payload: {
      runIndexId: input.runIndexId,
      counts: state.counts,
      rubricVersions: finalised.rubric_versions,
    },
  })

  log.info('shortlist finalised', {
    shortlistId: finalised.shortlist_id, ...state.counts,
  })

  return finalised
}

/** The blocking states in words, so the refusal says what to do rather than only that it will not. */
function describeBlocking(blocking: readonly BlockingItem[]): string {
  const counts = {
    UNDECIDED: blocking.filter((b) => b.state === 'UNDECIDED').length,
    HOLD: blocking.filter((b) => b.state === 'HOLD').length,
    FLAGS_UNREVIEWED: blocking.filter((b) => b.state === 'FLAGS_UNREVIEWED').length,
  }

  const parts: string[] = []
  if (counts.UNDECIDED > 0) parts.push(`${counts.UNDECIDED} with no decision recorded`)
  if (counts.HOLD > 0) parts.push(`${counts.HOLD} on hold`)
  if (counts.FLAGS_UNREVIEWED > 0) {
    parts.push(
      `${counts.FLAGS_UNREVIEWED} decided but still carrying an unanswered caveat`)
  }
  return `${parts.join(', ')}.`
}

export async function reopen(input: {
  runIndexId: number
  actor: string
  reason: string
}): Promise<ShortlistRow> {
  const shortlist = await selectShortlist(input.runIndexId)
  if (!shortlist) {
    throw new AppError('NOT_FOUND', `Scoring run ${input.runIndexId} has no shortlist.`)
  }

  const reopened = await reopenShortlist(shortlist.shortlist_id)
  if (!reopened) {
    throw new AppError(
      'CONFLICT',
      `Shortlist ${shortlist.shortlist_id} is not final, so there is nothing to reopen.`,
    )
  }

  // Reopening a locked outcome is the most consequential act in this module, so it is audited
  // with its reason even though the schema does not demand one.
  await recordAudit({
    actor: input.actor,
    action: 'review.shortlist_reopened',
    subjectType: 'shortlist',
    subjectId: String(reopened.shortlist_id),
    payload: { runIndexId: input.runIndexId, reason: input.reason },
  })

  return reopened
}

/** Every decision ever taken about one team, newest first (E23). */
export const decisionHistory = selectDecisionHistory
