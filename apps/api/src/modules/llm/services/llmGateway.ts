/**
 * The LLM gateway (E01-S04, P3.1–P3.6, P4.1–P4.2).
 *
 * Every model call in Crucible goes through `callModel`. That is enforced three ways: this
 * module is the only caller of the provider registry, `guard:llm` fails CI on a direct provider
 * call, and an unregistered `callKey` is rejected at runtime.
 *
 * This file is the orchestrator only (P2). Its collaborators:
 *   - `callResolver`   — registration, config and DB-stored prompts (P3.2, P3.3, P3.6)
 *   - `attemptRunner`  — one attempt: provider → JSON recovery → schema validation (P4.1)
 *   - `retryStrategy`  — which different thing to try next (P4.2)
 *   - `callAuditor`    — the audit row for every attempt (P3.4)
 *   - `fallbackRunner` — the deterministic degraded path, where one is declared (P3.5)
 */
import { createLogger } from '../../../lib/logger.js'
import { AppError } from '../../../lib/appError.js'
import { Semaphore } from '../../../lib/semaphore.js'
import { getNumber } from '../../platform/services/configService.js'
import { runAttempt } from './attemptRunner.js'
import { resolveCall } from './callResolver.js'
import { hashPrompt, recordAttempt } from './callAuditor.js'
import { backoffDelayMs, planFor } from './retryStrategy.js'
import { runFallback } from './fallbackRunner.js'
import type {
  CallModelInput, CallModelResult, FailureClass, ResolvedCall, TokenUsage,
} from '../types/llmTypes.js'

const log = createLogger('llm', 'gateway')

let semaphore: Semaphore | null = null

async function gate(): Promise<Semaphore> {
  const limit = await getNumber('llm.concurrency')
  if (!semaphore) semaphore = new Semaphore(limit)
  else semaphore.resize(limit)
  return semaphore
}

/** Test seam. */
export function resetGateway(): void {
  semaphore = null
}

export async function callModel<T>(input: CallModelInput<T>): Promise<CallModelResult<T>> {
  if (!input.callKey) {
    throw new AppError('INTERNAL_ERROR', 'callKey is mandatory on every gateway call (P3.2).')
  }
  const sem = await gate()
  return sem.run(() => execute(input))
}

async function execute<T>(input: CallModelInput<T>): Promise<CallModelResult<T>> {
  const resolved = await resolveCall(input)
  const { config, registration } = resolved

  if (!config.enabled) await refuseDisabled(input, config.model)

  const maxAttempts = Math.min(config.maxAttempts, await getNumber('llm.max_attempts'))
  const baseDelay = await getNumber('llm.retry_base_delay_ms')
  const started = Date.now()

  let failure: FailureClass | null = null
  let lastError = 'unknown'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const plan = planFor(failure)
    const model = chooseModel(input, resolved, plan.switchModel)
    const user = plan.reinforcement
      ? `${resolved.userPrompt}\n\n${plan.reinforcement}`
      : resolved.userPrompt

    const outcome = await runAttempt({
      model,
      system: resolved.systemPrompt,
      user,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeoutMs: Math.round(config.timeoutMs * plan.timeoutScale),
      schema: input.schema,
      ...(input.semantic && { semantic: input.semantic }),
    })

    const promptHash = hashPrompt(resolved.systemPrompt, user)

    if (outcome.kind === 'ok') {
      await recordSuccess({
        input, outcome, attempt, promptHash, user,
        logPrompts: config.logPrompts, logResponses: config.logResponses,
      })
      return {
        data: outcome.data, callKey: input.callKey, model: outcome.model, attempts: attempt,
        latencyMs: Date.now() - started, usage: outcome.usage, costUsd: outcome.costUsd,
        fromFallback: false,
      }
    }

    failure = outcome.failure
    lastError = outcome.error
    await recordAttempt({
      callKey: input.callKey, runId: input.runId ?? null, subject: input.subject, model: outcome.model,
      status: outcome.status, attempt, latencyMs: outcome.latencyMs, usage: outcome.usage,
      costUsd: outcome.costUsd, promptHash,
      responseText: config.logResponses ? outcome.responseText : null,
      error: outcome.error,
    })

    if (outcome.terminal) break
    // Scaled by the failure class: a rate limit waits longer than a generic provider error.
    if (attempt < maxAttempts) {
      await sleep(backoffDelayMs(attempt, baseDelay, planFor(failure).backoffScale))
    }
  }

  log.error('llm call exhausted attempts', {
    callKey: input.callKey, attempts: maxAttempts, failure, lastError,
  })

  if (registration.hasFallback) {
    const degraded = await serveFallback(input, {
      model: config.model, attempts: maxAttempts, startedAt: started, lastError,
    })
    if (degraded) return degraded
  }

  // P3.5's stated exception: where judgement cannot be obtained there is no honest substitute.
  throw new AppError(
    'UPSTREAM_UNAVAILABLE',
    `LLM call '${input.callKey}' failed after ${maxAttempts} attempt(s): ${lastError}`,
    { details: { callKey: input.callKey, failure, attempts: maxAttempts }, retryable: true },
  )
}

/** Audit an accepted response — one that passed schema, content and semantic validation. */
async function recordSuccess<T>(args: {
  input: CallModelInput<T>
  outcome: {
    model: string; latencyMs: number; usage: TokenUsage; costUsd: number
    responseText: string | null; repairedBy?: string | null
  }
  attempt: number
  promptHash: string
  user: string
  logPrompts: boolean
  logResponses: boolean
}): Promise<void> {
  const { input, outcome, attempt, promptHash, user, logPrompts, logResponses } = args
  await recordAttempt({
    callKey: input.callKey, runId: input.runId ?? null, subject: input.subject,
    model: outcome.model, status: 'OK', attempt, latencyMs: outcome.latencyMs,
    usage: outcome.usage, costUsd: outcome.costUsd, promptHash,
    promptText: logPrompts ? user : null,
    responseText: logResponses ? outcome.responseText : null,
  })
  log.info('llm call ok', {
    callKey: input.callKey, model: outcome.model, attempt,
    latencyMs: outcome.latencyMs, tokensIn: outcome.usage.tokensIn,
    tokensOut: outcome.usage.tokensOut, costUsd: outcome.costUsd,
    repairedBy: outcome.repairedBy,
  })
}

/** Records the refusal, then throws. Never returns. */
async function refuseDisabled<T>(input: CallModelInput<T>, model: string): Promise<never> {
  await recordAttempt({
    callKey: input.callKey, runId: input.runId ?? null, subject: input.subject, model,
    status: 'DISABLED', attempt: 1, latencyMs: 0,
    usage: { tokensIn: 0, tokensOut: 0 }, costUsd: 0, promptHash: '',
    error: 'call key disabled',
  })
  throw new AppError('UPSTREAM_UNAVAILABLE', `LLM call key '${input.callKey}' is disabled.`)
}

/** The declared deterministic degraded path (P3.5), or null when it cannot be served. */
async function serveFallback<T>(
  input: CallModelInput<T>,
  context: { model: string; attempts: number; startedAt: number; lastError: string },
): Promise<CallModelResult<T> | null> {
  const { model, attempts, startedAt, lastError } = context
  const fallback = await runFallback<T>(input.callKey, input)
  if (fallback === null) return null

  await recordAttempt({
    callKey: input.callKey, runId: input.runId ?? null, subject: input.subject, model,
    status: 'FALLBACK', attempt: attempts, latencyMs: Date.now() - startedAt,
    usage: { tokensIn: 0, tokensOut: 0 }, costUsd: 0, promptHash: '',
    error: `fallback after: ${lastError}`, fallbackTriggered: true,
  })
  return {
    data: fallback, callKey: input.callKey, model, attempts,
    latencyMs: Date.now() - startedAt, usage: { tokensIn: 0, tokensOut: 0 },
    costUsd: 0, fromFallback: true,
  }
}

function chooseModel<T>(
  input: CallModelInput<T>,
  resolved: ResolvedCall,
  switchModel: boolean,
): string {
  if (input.modelOverride) return input.modelOverride
  // The fallback, not a reviewer: this is the model a retry switches to after an empty
  // response. No second-opinion pass exists anywhere in this system (P4.3 is unmet for the
  // four scoring call keys — see the remediation epics).
  if (switchModel && resolved.config.fallbackModel) return resolved.config.fallbackModel
  return resolved.config.model
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
