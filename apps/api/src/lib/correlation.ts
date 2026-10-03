/**
 * Correlation IDs end-to-end (P9.2).
 *
 * One HTTP request, one background job, or one cohort evaluation carries a single id through
 * every DB query, LLM call and container probe it causes. Held in AsyncLocalStorage so callers
 * never thread it through signatures by hand — a threaded id gets dropped at the first refactor.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export interface CorrelationContext {
  /** Stable across the whole causal chain. Surfaced as the X-Request-ID response header. */
  correlationId: string
  /** Set once a request is authenticated; used for audit attribution (P9.1, E09-S01). */
  actor?: string
  /** Set inside a batch run so every line is attributable to the cohort evaluation. */
  runId?: string
  /** Set while a submission is being processed inside a run. */
  submissionId?: string
}

const storage = new AsyncLocalStorage<CorrelationContext>()

export function newCorrelationId(): string {
  return randomUUID()
}

/** Run `fn` inside a fresh correlation scope. */
export function withCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** The active context, or undefined outside any scope (e.g. boot-time logging). */
export function currentContext(): CorrelationContext | undefined {
  return storage.getStore()
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId
}

/**
 * Mutate the active scope. Used when facts become known mid-request — the actor after auth, the
 * submission id once a run picks one up. Safe to call outside a scope; it is then a no-op.
 */
export function enrichContext(patch: Partial<Omit<CorrelationContext, 'correlationId'>>): void {
  const ctx = storage.getStore()
  if (!ctx) return
  Object.assign(ctx, patch)
}
