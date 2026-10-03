/**
 * Writes the P3.4 audit row for one gateway attempt.
 *
 * Takes a single descriptor rather than a long parameter list: a twelve-argument logging call is
 * a defect waiting to happen, because two same-typed arguments transposed produce a plausible
 * but wrong audit record — and an audit record nobody can trust is worse than none.
 */
import { createHash } from 'node:crypto'
import { currentCorrelationId } from '../../../lib/correlation.js'
import { createLogger } from '../../../lib/logger.js'
import { accrueCost } from '../../platform/services/runLedgerService.js'
import { insertCallLog } from '../db/llmCallLogDb.js'
import type { CallStatus, TokenUsage } from '../types/llmTypes.js'

const log = createLogger('llm', 'callAuditor')

export interface AttemptRecord {
  callKey: string
  runId: number | null
  subject?: { type: string; id: string } | undefined
  model: string
  status: CallStatus
  attempt: number
  latencyMs: number
  usage: TokenUsage
  costUsd: number
  promptHash: string
  /** Stored only when the call key opts in (P3.4). */
  promptText?: string | null
  responseText?: string | null
  error?: string | null
  fallbackTriggered?: boolean
}

export const hashPrompt = (system: string, user: string): string =>
  createHash('sha256').update(`${system}\u0000${user}`).digest('hex')

/** Never throws — logging a call must not fail the call (P3.4). */
export async function recordAttempt(record: AttemptRecord): Promise<void> {
  await insertCallLog({
    callKey: record.callKey,
    correlationId: currentCorrelationId() ?? null,
    runId: record.runId,
    subjectType: record.subject?.type ?? null,
    subjectId: record.subject?.id ?? null,
    modelUsed: record.model,
    status: record.status,
    attempt: record.attempt,
    latencyMs: record.latencyMs,
    tokensIn: record.usage.tokensIn,
    tokensOut: record.usage.tokensOut,
    costUsd: record.costUsd,
    promptHash: record.promptHash || createHash('sha256').update(record.callKey).digest('hex'),
    promptText: record.promptText ?? null,
    responseText: record.responseText ?? null,
    fallbackTriggered: record.fallbackTriggered ?? false,
    error: record.error ? record.error.slice(0, 2000) : null,
  })

  await rollUpCost(record)
}

/**
 * Add this attempt's cost to its run's running total (E10-S03 acceptance 1).
 *
 * Done here because this is the one place every attempt passes through — successes, failures,
 * retries and fallbacks alike. A failed attempt still consumed tokens and still cost money, so
 * excluding it would let a run that retries heavily overshoot its ceiling while reporting that
 * it had not.
 *
 * Without this the per-call costs were recorded on `llm_call_log` and never summed anywhere:
 * `run.cost_usd` stayed at zero for every run, and the E10-S03 ceiling could not fire.
 *
 * Never throws, for the same reason the audit write does not: accounting must not fail a call.
 */
async function rollUpCost(record: AttemptRecord): Promise<void> {
  if (record.runId === null || record.costUsd <= 0) return
  try {
    await accrueCost(record.runId, record.costUsd)
  } catch (err) {
    log.error('could not accrue cost to the run', {
      runId: record.runId, costUsd: record.costUsd, err,
    })
  }
}
