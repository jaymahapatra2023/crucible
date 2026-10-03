/**
 * The one contract every LLM provider implements (P1.5 clause 1, P12.2).
 *
 * Adding a provider is one strategy file plus one registry line. Nothing outside this directory
 * knows a provider exists — the gateway talks to the registry, and `guard:llm` fails CI if any
 * other file reaches a provider SDK or endpoint directly (P3.1).
 */

export interface ProviderRequest {
  model: string
  system: string
  user: string
  maxTokens: number
  temperature: number
  timeoutMs: number
}

export interface ProviderResponse {
  text: string
  tokensIn: number
  tokensOut: number
  /** Provider-reported stop reason; `max_tokens` is what truncation repair exists for. */
  stopReason: string
}

/** Classified transport failures (P4.2) — the gateway chooses a retry strategy from this. */
export type ProviderErrorKind = 'TIMEOUT' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'UNAVAILABLE'

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly retryable: boolean
  readonly statusCode: number | undefined

  constructor(kind: ProviderErrorKind, message: string, statusCode?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProviderError'
    this.kind = kind
    this.statusCode = statusCode
    this.retryable = kind === 'TIMEOUT' || kind === 'RATE_LIMITED' || kind === 'UNAVAILABLE'
  }
}

export interface ModelProvider {
  readonly name: string
  /** False when the provider has no credential — the gateway then reports a named error. */
  isAvailable(): boolean
  complete(req: ProviderRequest): Promise<ProviderResponse>
}
