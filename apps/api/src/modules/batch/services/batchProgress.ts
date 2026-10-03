/**
 * Reading a run's progress (E10-S05).
 *
 * The websocket carries progress live; this reads it back. Acceptance 2 is "survives page
 * reload", and a reload has no history — so everything the live feed shows has to be readable
 * here too, from state the run wrote down rather than from messages it emitted.
 */
import { AppError } from '../../../lib/appError.js'
import { getRun } from '../../platform/services/runLedgerService.js'
import { runFailures, selectProgress, stageCounts } from '../db/batchDb.js'
import { selectSubjectCosts } from '../../llm/db/llmCallLogDb.js'
import { STAGES, type Stage } from './batchOrchestrator.js'

export interface BatchProgress {
  runId: number
  status: string
  startedAt: Date
  finishedAt: Date | null
  costUsd: number
  /** Null until a stage has been measured — never a guess (E10-S02 acceptance 3). */
  estimatedFinishAt: Date | null
  projectedCostUsd: number | null
  currentStage: string | null
  currentSubject: string | null
  currentLabel: string | null
  completed: number
  total: number
  stages: Array<{
    stage: Stage
    ok: number
    failed: number
    skipped: number
    /** Everything this stage has finished with, however it finished. */
    done: number
  }>
  failures: Array<{ stage: string; subjectId: string | null; message: string }>
  /** Set when the run stopped for a reason an operator has to act on. */
  pausedReason: string | null
  /**
   * Spend attributed to each submission, dearest first (E10-S03 acceptance 1).
   *
   * Read from the call log rather than from score rows, so a submission whose criteria FAILED
   * after paid attempts still shows what it cost. `failedCalls` is carried alongside because a
   * submission that is expensive through retries is a different problem from one that is
   * expensive through size.
   */
  costBySubmission: Array<{
    submissionId: string; costUsd: number; calls: number; failedCalls: number
  }>
}

export async function batchProgress(runId: number): Promise<BatchProgress> {
  const run = await getRun(runId)
  if (!run) throw new AppError('NOT_FOUND', `Run ${runId} was not found.`)

  const [progress, counts, failures, perSubmission] = await Promise.all([
    selectProgress(runId),
    stageCounts(runId),
    runFailures(runId),
    selectSubjectCosts(runId),
  ])

  return {
    runId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    costUsd: Number(run.costUsd),
    ...position(progress),
    stages: stageRows(counts),
    failures: failures.map((f) => ({
      stage: f.stage, subjectId: f.subject_id, message: f.message,
    })),
    // The run row's `error` carries the pause reason while paused, and the failure reason
    // otherwise; only the first is something an operator resumes from.
    pausedReason: run.status === 'PAUSED' ? run.error : null,
    costBySubmission: perSubmission.map((c) => ({
      submissionId: c.subjectId, costUsd: c.costUsd, calls: c.calls, failedCalls: c.failedCalls,
    })),
  }
}

/** Where the run is now, or a run that has not written a position yet. */
function position(progress: Awaited<ReturnType<typeof selectProgress>>) {
  if (!progress) {
    return {
      estimatedFinishAt: null, projectedCostUsd: null,
      currentStage: null, currentSubject: null, currentLabel: null,
      completed: 0, total: 0,
    }
  }

  return {
    estimatedFinishAt: progress.estimated_finish_at,
    // Null stays null: "not yet projectable" and "projected at zero" are different answers.
    projectedCostUsd: progress.projected_cost_usd === null
      ? null
      : Number(progress.projected_cost_usd),
    currentStage: progress.stage,
    currentSubject: progress.current_subject,
    currentLabel: progress.current_label,
    completed: progress.completed,
    total: progress.total,
  }
}

/**
 * Every stage, including those that have not started.
 *
 * Listing all three from the first second shows the shape of the run, rather than making it
 * appear a stage at a time as though each were a surprise.
 */
function stageRows(counts: Awaited<ReturnType<typeof stageCounts>>): BatchProgress['stages'] {
  const byStage = new Map(counts.map((c) => [c.stage, c]))

  return STAGES.map((stage) => {
    const row = byStage.get(stage)
    const ok = (row?.ok ?? 0) + (row?.warning ?? 0)
    const failed = row?.failed ?? 0
    const skipped = row?.skipped ?? 0
    return { stage, ok, failed, skipped, done: ok + failed + skipped }
  })
}
