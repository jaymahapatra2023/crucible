/**
 * One gateway attempt: call the provider, recover JSON, and run all three of P4.1's validations.
 *
 * Schema, content and SEMANTIC checks live here together because P4.1 names them together as
 * what must pass before an output is stored. Splitting the third out into the orchestration loop
 * would make it look optional, and it is not.
 *
 * Returns a *classified* outcome rather than throwing, so the orchestration loop can choose the
 * next strategy from the failure class (P4.2) instead of inspecting exception types.
 */
import type { ZodType, ZodTypeDef } from 'zod'
import { errorMessage } from '../../../lib/appError.js'
import { providerFor } from '../providers/providerRegistry.js'
import { ProviderError } from '../providers/providerContract.js'
import { extractJson } from './jsonExtraction.js'
import { estimateCost } from './costModel.js'
import { classify } from './retryStrategy.js'
import type { AttemptOutcome, SemanticVerdict } from '../types/llmTypes.js'

export interface AttemptInput<T> {
  model: string
  system: string
  user: string
  maxTokens: number
  temperature: number
  timeoutMs: number
  schema: ZodType<T, ZodTypeDef, unknown>
  /**
   * P4.1's third validation, supplied by the caller.
   *
   * Only the caller has what it takes to judge — the scan a citation claims to come from is the
   * scoring module's, not the gateway's — so this stays a parameter and the gateway stays
   * generic (P1.1).
   */
  semantic?: (data: T) => SemanticVerdict
}

export async function runAttempt<T>(input: AttemptInput<T>): Promise<AttemptOutcome<T>> {
  const started = Date.now()
  const zero = { tokensIn: 0, tokensOut: 0 }

  let text: string
  let usage: { tokensIn: number; tokensOut: number }
  try {
    const provider = providerFor()
    const res = await provider.complete({
      model: input.model,
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      timeoutMs: input.timeoutMs,
    })
    text = res.text
    usage = { tokensIn: res.tokensIn, tokensOut: res.tokensOut }
  } catch (err) {
    const failure = classify(err)
    return {
      kind: 'failure',
      failure,
      status: failure === 'TIMEOUT' ? 'TIMEOUT' : failure === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
      error: errorMessage(err),
      model: input.model,
      usage: zero,
      costUsd: 0,
      latencyMs: Date.now() - started,
      responseText: null,
      // A non-retryable provider refusal will not be fixed by another attempt.
      terminal: err instanceof ProviderError && !err.retryable,
    }
  }

  const costUsd = await estimateCost(input.model, usage)
  const latencyMs = Date.now() - started
  const base = { model: input.model, usage, costUsd, latencyMs, terminal: false as const }

  if (text.trim() === '') {
    return {
      kind: 'failure', failure: 'CONTENT_EMPTY', status: 'PARSE_FAILED',
      error: 'model returned empty content', responseText: text, ...base,
    }
  }

  const extracted = extractJson(text)
  if (!extracted.ok) {
    return {
      kind: 'failure', failure: 'JSON_PARSE_ERROR', status: 'PARSE_FAILED',
      error: extracted.error ?? 'no JSON found', responseText: text, ...base,
    }
  }

  const parsed = input.schema.safeParse(extracted.value)
  if (!parsed.success) {
    return {
      kind: 'failure', failure: 'SCHEMA_INVALID', status: 'SCHEMA_INVALID',
      error: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500),
      responseText: text, ...base,
    }
  }

  // The third validation. A well-formed answer that cites something untrue has satisfied the
  // schema and is still not usable.
  const semantic = input.semantic?.(parsed.data) ?? { ok: true as const }
  if (!semantic.ok) {
    return {
      kind: 'failure', failure: semantic.failure, status: 'SEMANTIC_INVALID',
      error: semantic.error, responseText: text, ...base,
    }
  }

  return {
    kind: 'ok',
    data: parsed.data,
    model: input.model,
    usage,
    costUsd,
    latencyMs,
    repairedBy: extracted.method,
    responseText: text,
  }
}
