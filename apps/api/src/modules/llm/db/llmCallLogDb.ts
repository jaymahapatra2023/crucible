/**
 * All SQL for the LLM call audit log (P3.4).
 *
 * Writes are fire-and-forget by contract: a logging failure must never propagate to the caller,
 * because losing a log line is strictly better than failing a scoring call that succeeded.
 */
import { query, queryOne } from '../../../db/pool.js'
import { createLogger } from '../../../lib/logger.js'
import type { CallStatus } from '../types/llmTypes.js'

const log = createLogger('llm', 'callLog')

export interface CallLogInput {
  callKey: string
  correlationId: string | null
  runId: number | null
  subjectType?: string | null
  subjectId?: string | null
  modelUsed: string
  status: CallStatus
  attempt: number
  latencyMs: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  promptHash: string
  promptText: string | null
  responseText: string | null
  fallbackTriggered: boolean
  error: string | null
}

/** Never throws (P3.4). */
export async function insertCallLog(input: CallLogInput): Promise<void> {
  try {
    await query(
      `INSERT INTO llm_call_log
         (call_key, correlation_id, run_id, model_used, status, attempt, latency_ms,
          tokens_in, tokens_out, cost_usd, prompt_hash, prompt_text, response_text,
          fallback_triggered, error, subject_type, subject_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [input.callKey, input.correlationId, input.runId, input.modelUsed, input.status,
       input.attempt, input.latencyMs, input.tokensIn, input.tokensOut, input.costUsd,
       input.promptHash, input.promptText, input.responseText, input.fallbackTriggered,
       input.error, input.subjectType ?? null, input.subjectId ?? null],
    )
  } catch (err) {
    log.error('call log write failed', { err, callKey: input.callKey })
  }
}

export interface CallKeyMetrics {
  callKey: string
  calls: number
  okCount: number
  errorRate: number
  fallbackRate: number
  p50LatencyMs: number
  p90LatencyMs: number
  p99LatencyMs: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

/** Per-call_key metrics (P9.3). Bounded by a time window so the query stays indexed (P11.3). */
export async function selectCallKeyMetrics(sinceHours: number): Promise<CallKeyMetrics[]> {
  const res = await query<{
    call_key: string; calls: number; ok_count: number; fallback_count: number
    p50: number; p90: number; p99: number
    tokens_in: number; tokens_out: number; cost_usd: number
  }>(
    `SELECT call_key,
            COUNT(*)::int                                            AS calls,
            COUNT(*) FILTER (WHERE status = 'OK')::int               AS ok_count,
            COUNT(*) FILTER (WHERE fallback_triggered)::int          AS fallback_count,
            COALESCE(percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50,
            COALESCE(percentile_disc(0.90) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p90,
            COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p99,
            COALESCE(SUM(tokens_in), 0)::int                         AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::int                        AS tokens_out,
            COALESCE(SUM(cost_usd), 0)                               AS cost_usd
       FROM llm_call_log
      WHERE at > now() - ($1 || ' hours')::interval
      GROUP BY call_key
      ORDER BY call_key`,
    [String(sinceHours)],
  )
  return res.rows.map((r) => ({
    callKey: r.call_key,
    calls: r.calls,
    okCount: r.ok_count,
    errorRate: r.calls === 0 ? 0 : (r.calls - r.ok_count) / r.calls,
    fallbackRate: r.calls === 0 ? 0 : r.fallback_count / r.calls,
    p50LatencyMs: r.p50, p90LatencyMs: r.p90, p99LatencyMs: r.p99,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: Number(r.cost_usd),
  }))
}

/** Spend so far on a run, read from the published cost view (P1.3). */
/** Spend per subject within a run, from the call log itself (E10-S03 acceptance 1). */
export async function selectSubjectCosts(runId: number): Promise<
  Array<{ subjectId: string; costUsd: number; calls: number; failedCalls: number }>
> {
  const res = await query<{
    subject_id: string; cost_usd: number; calls: number; failed_calls: number
  }>(
    `SELECT subject_id, cost_usd, calls, failed_calls FROM v_llm_subject_cost
      WHERE run_id = $1 AND subject_type = 'submission'
      ORDER BY cost_usd DESC`,
    [runId])
  return res.rows.map((r) => ({
    subjectId: r.subject_id,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
    failedCalls: Number(r.failed_calls),
  }))
}

export async function selectRunCost(runId: number): Promise<number> {
  const row = await queryOne<{ cost_usd: number }>(
    'SELECT COALESCE(cost_usd, 0) AS cost_usd FROM v_llm_run_cost WHERE run_id = $1',
    [runId],
  )
  return Number(row?.cost_usd ?? 0)
}
