/**
 * Run ledger (E01-S05).
 *
 * Every long-running operation opens a run, records a result for each stage it attempts, and
 * closes the run. The ledger is the answer to "what happened last night" — it is designed so
 * that answering that question never requires reading a log file (acceptance 3), and so that a
 * failed batch can be resumed rather than restarted (E10-S04).
 *
 * `stage()` is the single entry point for recording work. It captures timing, classifies the
 * outcome, and guarantees that a throwing stage is recorded as `failed` rather than vanishing —
 * a ledger that only records successes is worse than none, because it looks complete.
 */
import { createLogger } from '../../../lib/logger.js'
import { AppError } from '../../../lib/appError.js'
import { errorMessage } from '../../../lib/appError.js'
import { enrichContext, newCorrelationId, currentCorrelationId } from '../../../lib/correlation.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { publish, runTopic } from '../../../http/progressHub.js'
import {
  addRunCost, countRuns, insertRun, listRuns, selectCompletedSubjects, selectProgress,
  selectRun, selectStages, updateRunStatus, upsertStageResult,
} from '../db/runDb.js'
import type { Run, RunDetail, RunKind, RunStatus, StageOutcome } from '../types/runTypes.js'

const log = createLogger('platform', 'runLedger')

export interface OpenRunInput {
  kind: RunKind
  params?: Record<string, unknown>
  /** Config snapshot pinned for the life of the run (P4.4). */
  pinnedConfig?: Record<string, unknown>
  startedBy?: string | null
}

export async function openRun(input: OpenRunInput): Promise<Run> {
  const run = await insertRun({
    kind: input.kind,
    params: input.params ?? {},
    pinnedConfig: input.pinnedConfig ?? {},
    correlationId: currentCorrelationId() ?? newCorrelationId(),
    startedBy: input.startedBy ?? null,
  })
  enrichContext({ runId: String(run.runId) })
  await updateRunStatus(run.runId, 'RUNNING', null)
  log.info('run opened', { runId: run.runId, kind: run.kind })
  publish(runTopic(run.runId), 'status', { status: 'RUNNING', kind: run.kind })
  await recordAudit({
    actor: input.startedBy ?? 'system',
    action: 'run.started',
    subjectType: 'run',
    subjectId: String(run.runId),
    payload: { kind: run.kind, params: input.params ?? {} },
  })
  return { ...run, status: 'RUNNING' }
}

export interface StageOptions {
  runId: number
  stage: string
  subjectType?: string
  subjectId?: string | null
  attempt?: number
}

/**
 * Run one stage and record its outcome.
 *
 * A stage returns `{ outcome, message, detail }` to express `warning` or `skipped` explicitly;
 * returning nothing means `ok`. Throwing records `failed` and rethrows, so the caller decides
 * whether one failure ends the run — failure isolation is the batch module's policy
 * (E10-S04), not the ledger's.
 */
export async function stage<T>(
  opts: StageOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  const base = {
    runId: opts.runId,
    stage: opts.stage,
    subjectType: opts.subjectType ?? 'RUN',
    subjectId: opts.subjectId ?? null,
    attempt: opts.attempt ?? 1,
  }
  if (opts.subjectId) enrichContext({ submissionId: opts.subjectId })

  try {
    const result = await fn()
    const meta = extractMeta(result)
    // Guarded for the same reason the failure path below is guarded, which was the asymmetry
    // here: bookkeeping must not destroy the work it is recording. An unguarded write turned a
    // check that HAD succeeded into a failed one whenever the ledger row was unreachable, and
    // because the caller then threw, the pre-flight it belonged to stayed RUNNING until the
    // watchdog gave up and told the team their entry could not be checked. Observed as a
    // foreign-key violation when a run was removed while its drain was still in flight.
    try {
      await upsertStageResult({
        ...base,
        outcome: meta.outcome,
        message: meta.message,
        detail: meta.detail,
        durationMs: Date.now() - started,
      })
      publish(runTopic(opts.runId), 'stage', {
        stage: opts.stage,
        subjectId: opts.subjectId ?? null,
        outcome: meta.outcome,
        message: meta.message,
        durationMs: Date.now() - started,
      })
    } catch (ledgerErr: unknown) {
      log.error('failed to record stage success', { err: ledgerErr, stage: opts.stage })
    }
    return result
  } catch (err) {
    await upsertStageResult({
      ...base,
      outcome: 'failed',
      message: errorMessage(err).slice(0, 2000),
      detail: err instanceof AppError ? { code: err.code, retryable: err.retryable } : {},
      durationMs: Date.now() - started,
    }).catch((ledgerErr: unknown) => {
      // A ledger write failure must not mask the real failure.
      log.error('failed to record stage failure', { err: ledgerErr, stage: opts.stage })
    })
    publish(runTopic(opts.runId), 'stage', {
      stage: opts.stage,
      subjectId: opts.subjectId ?? null,
      outcome: 'failed',
      message: errorMessage(err).slice(0, 500),
      durationMs: Date.now() - started,
    })
    log.warn('stage failed', { runId: opts.runId, stage: opts.stage, subjectId: opts.subjectId, err })
    throw err
  }
}

/** A stage may return this shape to declare a non-ok outcome without throwing. */
export interface StageOutcomeHint {
  __stage: { outcome: StageOutcome; message?: string; detail?: Record<string, unknown> }
}

export function stageOutcome(
  outcome: StageOutcome,
  message?: string,
  detail?: Record<string, unknown>,
): StageOutcomeHint {
  return { __stage: { outcome, ...(message !== undefined && { message }), ...(detail !== undefined && { detail }) } }
}

function extractMeta(result: unknown): {
  outcome: StageOutcome; message: string | null; detail: Record<string, unknown>
} {
  const hint = (result as Partial<StageOutcomeHint> | null)?.__stage
  if (hint) {
    return { outcome: hint.outcome, message: hint.message ?? null, detail: hint.detail ?? {} }
  }
  return { outcome: 'ok', message: null, detail: {} }
}

export async function closeRun(runId: number, status: RunStatus, error?: string): Promise<Run> {
  const run = await updateRunStatus(runId, status, error ?? null)
  if (!run) throw new AppError('NOT_FOUND', `Run ${runId} was not found.`)
  log.info('run closed', { runId, status, costUsd: run.costUsd })
  publish(runTopic(runId), 'status', { status, costUsd: run.costUsd, error: error ?? null })
  await recordAudit({
    actor: run.startedBy ?? 'system',
    action: 'run.finished',
    subjectType: 'run',
    subjectId: String(runId),
    payload: { status, costUsd: run.costUsd, error: error ?? null },
  })
  return run
}

/**
 * Pause a running batch (E10-S03 acceptance 2).
 *
 * Distinct from `closeRun`: a paused run has not finished, so `finished_at` stays null and it
 * remains resumable. Recorded as its own audit action, because "why did the overnight run stop
 * at 40 of 50" is the question an operator asks first.
 */
export async function pauseRun(runId: number, reason: string): Promise<Run> {
  const run = await updateRunStatus(runId, 'PAUSED', reason)
  if (!run) throw new AppError('NOT_FOUND', `Run ${runId} was not found.`)
  log.warn('run paused', { runId, reason, costUsd: run.costUsd })
  publish(runTopic(runId), 'status', { status: 'PAUSED', costUsd: run.costUsd, error: reason })
  await recordAudit({
    actor: run.startedBy ?? 'system',
    action: 'run.paused',
    subjectType: 'run',
    subjectId: String(runId),
    payload: { reason, costUsd: run.costUsd },
  })
  return run
}

export async function accrueCost(runId: number, deltaUsd: number): Promise<number> {
  if (deltaUsd <= 0) return 0
  const total = await addRunCost(runId, deltaUsd)
  publish(runTopic(runId), 'cost', { deltaUsd, totalUsd: total })
  return total
}

/** `GET /runs/:id` — current state without reading logs (E01-S05 acceptance 3). */
export async function getRunDetail(runId: number): Promise<RunDetail> {
  const run = await selectRun(runId)
  if (!run) throw new AppError('NOT_FOUND', `Run ${runId} was not found.`)
  const progress = await selectProgress(runId)
  if (!progress) throw new AppError('INTERNAL_ERROR', `Run ${runId} has no progress row.`)
  return { run, progress, stages: await selectStages(runId) }
}

export async function getRuns(limit: number, offset: number, kind?: RunKind) {
  const [runs, total] = await Promise.all([listRuns(limit, offset, kind), countRuns(kind)])
  return { runs, total }
}

/** Subjects already done for a stage, so a resume can skip them (E10-S04 acceptance 2). */
export async function completedSubjects(runId: number, stageName: string): Promise<Set<string>> {
  return new Set(await selectCompletedSubjects(runId, stageName))
}

export async function getRun(runId: number): Promise<Run | null> {
  return selectRun(runId)
}
