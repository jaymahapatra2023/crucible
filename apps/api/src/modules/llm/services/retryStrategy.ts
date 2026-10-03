/**
 * Classified retry (P4.2) — never retry blindly.
 *
 * Each failure class maps to a *different* next attempt. Repeating an identical request that
 * just failed is the behaviour this principle exists to forbid: it burns budget and latency to
 * re-roll the same dice.
 */
import type { FailureClass } from '../types/llmTypes.js'
import { ProviderError } from '../providers/providerContract.js'

export interface AttemptPlan {
  /** Extra instruction appended to the user turn for this attempt. */
  reinforcement: string
  /** Multiplier applied to the untrusted-context budget (TOO_SHORT halves it). */
  contextScale: number
  /** Multiplier applied to the configured timeout. */
  timeoutScale: number
  /** Prefer a faster model on this attempt. */
  preferFasterModel: boolean
  /** Try a different model entirely — used when output came back empty. */
  switchModel: boolean
  /**
   * Multiplier applied to the backoff before the next attempt.
   *
   * A rate limit is the provider saying "slow down", which is different information from a
   * random 500. Retrying it on the same ladder as any other transport error means a batch under
   * load spends its attempts racing the limit instead of waiting it out (E10-S02 acceptance 2).
   */
  backoffScale: number
}

const BASE_PLAN: AttemptPlan = {
  reinforcement: '',
  contextScale: 1,
  timeoutScale: 1,
  preferFasterModel: false,
  switchModel: false,
  backoffScale: 1,
}

/** P4.2's table, expressed as code so the mapping has exactly one definition. */
const STRATEGIES: Record<FailureClass, Partial<AttemptPlan>> = {
  TOO_SHORT: {
    contextScale: 0.5,
    reinforcement:
      'Your previous response was too short to be usable. Answer fully, covering every field.',
  },
  BAD_STRUCTURE: {
    reinforcement:
      'Your previous response did not match the required structure. Return ONLY a JSON object ' +
      'with exactly the required fields, and no surrounding prose.',
  },
  JSON_PARSE_ERROR: {
    reinforcement:
      'Your previous response could not be parsed as JSON. Return ONLY valid, complete JSON. ' +
      'Do not wrap it in a code fence and do not add commentary.',
  },
  /**
   * A well-formed answer that cited something untrue.
   *
   * The reinforcement names the specific failure rather than asking for more care in general,
   * because "be accurate" is not an instruction a model can act on. It restates the one rule
   * that was broken: quote only from what you were given.
   *
   * No context reduction — the model needs MORE of the source to cite it correctly, not less,
   * which is the opposite of the TOO_SHORT plan and the reason this cannot share it.
   */
  CITATION_UNVERIFIED: {
    reinforcement:
      'Your previous response cited a file, line range or quotation that does not exist in the ' +
      'source you were shown. Every citation must be copied from the excerpts above: use their ' +
      'exact path, a line range inside the range they cover, and text quoted verbatim from ' +
      'them. If you cannot support a judgement with a real citation, report insufficient ' +
      'evidence instead.',
  },
  SCHEMA_INVALID: {
    reinforcement:
      'Your previous response was valid JSON but did not satisfy the required schema. ' +
      'Re-read the field requirements and return every required field with the correct type.',
  },
  TIMEOUT: { timeoutScale: 2, preferFasterModel: true },
  CONTENT_EMPTY: { switchModel: true },
  RATE_LIMITED: { backoffScale: 4 },
  PROVIDER_ERROR: {},
}

export function planFor(failure: FailureClass | null): AttemptPlan {
  if (!failure) return BASE_PLAN
  return { ...BASE_PLAN, ...STRATEGIES[failure] }
}

/** Classify a thrown error or a validation outcome into a failure class. */
export function classify(err: unknown): FailureClass {
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'TIMEOUT': return 'TIMEOUT'
      case 'RATE_LIMITED': return 'RATE_LIMITED'
      default: return 'PROVIDER_ERROR'
    }
  }
  return 'PROVIDER_ERROR'
}

/**
 * Exponential backoff with full jitter. Jitter matters at Crucible's shape of load: fifty
 * submissions scored in parallel that all back off on the same schedule re-collide on every
 * retry, turning one rate-limit into a synchronised stampede.
 */
/** Longest a single wait may be: thirty seconds normally, a minute when told to slow down. */
const MAX_BACKOFF_MS = 30_000
const MAX_SCALED_BACKOFF_MS = 60_000

export function backoffDelayMs(attempt: number, baseMs: number, scale = 1): number {
  // The unscaled cap is unchanged at thirty seconds: raising it for every failure class would
  // make an unrelated provider hiccup stall a batch twice as long. Only a rate limit — where
  // the provider has explicitly asked us to wait — may exceed it, and not by much.
  const cap = scale > 1 ? MAX_SCALED_BACKOFF_MS : MAX_BACKOFF_MS
  const ceiling = Math.min(baseMs * scale * 2 ** (attempt - 1), cap)
  return Math.floor(Math.random() * ceiling)
}

/** Transport failures that justify a retry without changing the prompt. */
export function isTransport(failure: FailureClass): boolean {
  return failure === 'TIMEOUT' || failure === 'RATE_LIMITED' || failure === 'PROVIDER_ERROR'
}
