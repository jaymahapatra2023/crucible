/**
 * LLM gateway types (E01-S04, P3.x).
 */
import type { ZodType, ZodTypeDef } from 'zod'

export const CALL_STATUSES = [
  'OK', 'SCHEMA_INVALID', 'SEMANTIC_INVALID', 'PARSE_FAILED', 'TIMEOUT',
  'RATE_LIMITED', 'PROVIDER_ERROR', 'DISABLED', 'FALLBACK',
] as const
export type CallStatus = (typeof CALL_STATUSES)[number]

export const CRITICALITIES = ['CRITICAL', 'STANDARD', 'BEST_EFFORT'] as const
export type Criticality = (typeof CRITICALITIES)[number]

/** P4.2 — failures are classified before they are retried, never retried blindly. */
export const FAILURE_CLASSES = [
  'TOO_SHORT', 'BAD_STRUCTURE', 'JSON_PARSE_ERROR', 'TIMEOUT', 'CONTENT_EMPTY',
  'RATE_LIMITED', 'PROVIDER_ERROR', 'SCHEMA_INVALID', 'CITATION_UNVERIFIED',
] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

export interface CallRegistration {
  callKey: string
  module: string
  purpose: string
  criticality: Criticality
  inputVariables: string[]
  hasFallback: boolean
  failureIsTerminal: boolean
  requiresReview: boolean
}

export interface CallConfig {
  callKey: string
  model: string
  /** The model a retry switches to after an empty response. Not a reviewer (P4.2). */
  fallbackModel: string | null
  maxTokens: number
  temperature: number
  timeoutMs: number
  maxAttempts: number
  logPrompts: boolean
  logResponses: boolean
  enabled: boolean
}

export interface PromptTemplate {
  templateId: number
  callKey: string
  version: number
  role: 'system' | 'user'
  body: string
  contentHash: string
}

/** A span of untrusted, submission-supplied content (P8.4). Delimited and labelled, never
 *  interpolated raw and never placed in the system prompt. */
export interface UntrustedSpan {
  label: string
  content: string
}

export interface CallModelInput<T> {
  /** Mandatory and appears in every log line (E01-S04 acceptance 5, P3.2). */
  callKey: string
  /** Values substituted into the DB-stored prompt template's {{placeholders}} (P3.3). */
  variables?: Record<string, string | number | boolean>
  /** Submission-supplied content, delimited and labelled as data (P8.4). */
  untrusted?: UntrustedSpan[]
  /**
   * Schema the parsed output must satisfy before it is returned (P4.1).
   *
   * Typed with an explicit `unknown` input so a schema using `.default()` or `.transform()` is
   * accepted: `ZodType<T>` alone forces input and output to unify, which makes every defaulted
   * field read as possibly-undefined at the call site.
   */
  schema: ZodType<T, ZodTypeDef, unknown>
  /** Attributes cost and log rows to a run (E10-S03). */
  runId?: number
  /**
   * What this call is about — a submission, a challenge — so spend can be attributed per
   * subject and not only per run (E10-S03 acceptance 1).
   *
   * Summing a submission's cost from its score rows under-reports it: a criterion that fails
   * after three paid attempts records zero, and the money is still gone.
   */
  subject?: { type: string; id: string }
  /** Overrides the configured model for this call only; recorded on the log row. */
  modelOverride?: string
  /**
   * The third validation P4.1 requires, after schema and content: does this output satisfy the
   * quality criteria for its type?
   *
   * Supplied by the caller rather than built in, because only the caller has what it takes to
   * judge — the scan a citation claims to come from is the scoring module's, not the gateway's.
   * The gateway stays generic (P1.1) and the check still runs where P4.1 says it must, before
   * anything is returned.
   *
   * A failure re-enters the retry ladder with its own class, so a well-formed answer that fails
   * semantically is retried differently from one that failed to parse (P4.2).
   */
  semantic?: (data: T) => SemanticVerdict
}

/** The outcome of a caller-supplied semantic check. */
export type SemanticVerdict =
  | { ok: true }
  | { ok: false; failure: FailureClass; error: string }

export interface TokenUsage {
  tokensIn: number
  tokensOut: number
}

export interface CallModelResult<T> {
  data: T
  callKey: string
  model: string
  attempts: number
  latencyMs: number
  usage: TokenUsage
  costUsd: number
  /** True when a deterministic fallback produced this result rather than the model (P3.5). */
  fromFallback: boolean
}

/** The classified result of one gateway attempt (P4.2). */
export type AttemptOutcome<T> =
  | {
      kind: 'ok'
      data: T
      model: string
      usage: TokenUsage
      costUsd: number
      latencyMs: number
      /** How the JSON was recovered, so repair rates stay observable (P9.3). */
      repairedBy: string | undefined
      responseText: string
    }
  | {
      kind: 'failure'
      failure: FailureClass
      status: CallStatus
      error: string
      model: string
      usage: TokenUsage
      costUsd: number
      latencyMs: number
      responseText: string | null
      /** True when the provider itself refused in a way no reinforcement will fix. */
      terminal: boolean
    }

/** Everything one attempt needs, resolved once per call rather than per attempt. */
export interface ResolvedCall {
  registration: CallRegistration
  config: CallConfig
  systemPrompt: string
  userPrompt: string
  /** Injection findings from the untrusted spans (P8.4), surfaced to the caller. */
  injectionFindings: Array<{ label: string; pattern: string; excerpt: string }>
}
