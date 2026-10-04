/**
 * Anthropic provider adapter (P12.2).
 *
 * The only file in Crucible permitted to speak to a model API. Uses `fetch` rather than an SDK
 * so the dependency surface stays small and the timeout/abort path is explicit.
 *
 * P12.2 controls implemented here: explicit timeout, bounded retry classification handed back
 * to the gateway, and a circuit breaker that opens after consecutive failures.
 */
import { loadEnv } from '../../../config/env.js'
import { createLogger } from '../../../lib/logger.js'
import {
  ProviderError,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from './providerContract.js'

const log = createLogger('llm', 'anthropicProvider')

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

/** P12.2: 3 consecutive failures open the breaker for 60 s. */
const BREAKER_THRESHOLD = 3
const BREAKER_OPEN_MS = 60_000

let consecutiveFailures = 0
let breakerOpenedAt = 0

function breakerIsOpen(): boolean {
  if (consecutiveFailures < BREAKER_THRESHOLD) return false
  if (Date.now() - breakerOpenedAt > BREAKER_OPEN_MS) {
    consecutiveFailures = 0
    return false
  }
  return true
}

/** Test seam. */
export function resetBreaker(): void {
  consecutiveFailures = 0
  breakerOpenedAt = 0
}

interface AnthropicResponseBody {
  content?: Array<{ type: string; text?: string }>
  usage?: { input_tokens?: number; output_tokens?: number }
  stop_reason?: string
  error?: { type?: string; message?: string }
}

/**
 * Whether a model still accepts `temperature`.
 *
 * A deny-list rather than an allow-list: an unknown model is sent the parameter, which is the
 * behaviour every model before this family had. A new model that also refuses it will fail
 * loudly on its first call rather than silently scoring differently.
 */
export function acceptsTemperature(model: string): boolean {
  return !/^claude-(opus|sonnet|haiku|fable)-5/.test(model)
}

export const anthropicProvider: ModelProvider = {
  name: 'anthropic',

  isAvailable(): boolean {
    try {
      return Boolean(loadEnv().ANTHROPIC_API_KEY)
    } catch {
      return false
    }
  },

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const env = loadEnv()
    const apiKey = env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new ProviderError(
        'UNAVAILABLE',
        'ANTHROPIC_API_KEY is not configured; model-backed calls cannot run.',
      )
    }
    if (breakerIsOpen()) {
      throw new ProviderError(
        'UNAVAILABLE',
        `Provider circuit breaker is open after ${BREAKER_THRESHOLD} consecutive failures.`,
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), req.timeoutMs)

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          // Sent only to models that still accept it. The Claude 5 family refuses the request
          // outright — `400: "temperature" is deprecated for this model` — so including it
          // failed EVERY call. It went unnoticed because the calibration runs all went through
          // the CLI provider, which does not pass it; the first real use of this path at the
          // event lost 208 of 224 criterion scores to it.
          //
          // Determinism for those models therefore rests on the provider default rather than on
          // a parameter we set. That is a weaker guarantee and it is the honest one: scoring
          // measured its own reproducibility across two runs rather than assuming it.
          ...(acceptsTemperature(req.model) ? { temperature: req.temperature } : {}),
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw await httpError(res)

      const body = (await res.json()) as AnthropicResponseBody
      const text = (body.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('')

      consecutiveFailures = 0
      return {
        text,
        tokensIn: body.usage?.input_tokens ?? 0,
        tokensOut: body.usage?.output_tokens ?? 0,
        stopReason: body.stop_reason ?? 'unknown',
      }
    } catch (err) {
      recordFailure()
      if (err instanceof ProviderError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError('TIMEOUT', `Provider call exceeded ${req.timeoutMs}ms.`, undefined, err)
      }
      throw new ProviderError('PROVIDER_ERROR', 'Provider request failed.', undefined, err)
    } finally {
      clearTimeout(timer)
    }
  },
}

function recordFailure(): void {
  consecutiveFailures++
  if (consecutiveFailures === BREAKER_THRESHOLD) {
    breakerOpenedAt = Date.now()
    log.warn('provider circuit breaker opened', { consecutiveFailures })
  }
}

async function httpError(res: Response): Promise<ProviderError> {
  let detail = ''
  try {
    const body = (await res.json()) as AnthropicResponseBody
    detail = body.error?.message ?? ''
  } catch {
    detail = await res.text().catch(() => '')
  }
  const message = `Provider returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`
  if (res.status === 429) return new ProviderError('RATE_LIMITED', message, res.status)
  if (res.status >= 500) return new ProviderError('UNAVAILABLE', message, res.status)
  return new ProviderError('PROVIDER_ERROR', message, res.status)
}
