/**
 * What happens after the last submission is scored (E24).
 *
 * The batch used to stop at `score`, which left three acts between a scored cohort and anything
 * a reviewer could look at: compute the ranking, compute the run-to-run variance, open the
 * shortlist. None of them is a judgement — they are arithmetic and a table — and every one of
 * them was a person remembering to run something.
 *
 * That is the wrong place for a human. A reviewer's judgement belongs on the RESULT: moving a
 * team between shortlist, hold and exclude, with a reason. It does not belong in the mechanics
 * of producing the result, where forgetting a step looks exactly like a cohort that scored badly.
 *
 * The one thing here that can still stop is the calibration gate, and it stops deliberately.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { computeRanking } from '../../scoring/services/rankingService.js'
import { computeVariance } from '../../scoring/services/varianceService.js'
import { selectRunsForCohort } from '../../scoring/db/scoringDb.js'
import { openShortlist } from '../../review/services/shortlistService.js'

const log = createLogger('batch', 'finish')

export interface FinishOutcome {
  ranked: boolean
  /** False when the paired run does not exist yet — normal after run 1 of 2. */
  varianceComputed: boolean
  shortlistOpened: boolean
  /** Set when the calibration gate refused. The run pauses; it has not failed. */
  pausedReason: string | null
  /** What happened, in the words an operator reads on the run page. */
  note: string
}

/**
 * Rank, compare the runs, and open the shortlist.
 *
 * Idempotent: every step upserts, so resuming a paused run or re-running a finished one
 * produces the same state rather than a second shortlist or a duplicated ranking.
 */
export async function finishRun(input: {
  scoreRunId: number
  cohortKey: string
  actor: string
}): Promise<FinishOutcome> {
  const idle: FinishOutcome = {
    ranked: false, varianceComputed: false, shortlistOpened: false,
    pausedReason: null, note: '',
  }

  try {
    await computeRanking(input.scoreRunId, input.actor)
  } catch (err) {
    // The gate is the one deliberate stop in an otherwise automatic pipeline, and it refuses
    // RANKING only — the scores are real, recorded, and readable per team. Paused rather than
    // failed, so recording a decision (or enabling the bypass) and resuming finishes the job
    // instead of requiring the cohort to be scored again.
    if (err instanceof AppError && err.code === 'PRECONDITION_FAILED') {
      log.warn('ranking refused; run paused', { runIndexId: input.scoreRunId, reason: err.message })
      return { ...idle, pausedReason: err.message }
    }
    throw err
  }

  // Both runs, or none. A variance computed against a missing run would report perfect
  // agreement, which is the most misleading number this system could produce (E06-S06).
  const runs = await selectRunsForCohort(input.cohortKey)
  const paired = runs.some((r) => r.run_index === 1) && runs.some((r) => r.run_index === 2)
  if (paired) await computeVariance(input.cohortKey)

  await openShortlist(input.scoreRunId, input.actor, input.cohortKey)

  log.info('run finished', {
    runIndexId: input.scoreRunId, cohortKey: input.cohortKey, variance: paired,
  })

  return {
    ranked: true,
    varianceComputed: paired,
    shortlistOpened: true,
    pausedReason: null,
    note: paired
      ? 'Ranked, compared against the paired run, and a shortlist is open for review.'
      : 'Ranked and a shortlist is open for review. The run-to-run comparison waits for the '
        + 'second run of this cohort.',
  }
}
