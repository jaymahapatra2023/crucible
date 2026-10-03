/**
 * The Discord REST client (E49, P12.2): bot token, timeout, classified failures, retries with
 * backoff, a breaker. In `lib/` because two modules need it — submissions to DM a code, the
 * roster to resolve a username at registration — and neither may import the other's services.
 *
 * A refused request (closed DMs, unknown user, not in the server) is **REJECTED** and never
 * retried; transient failures retry behind the breaker. Nothing here logs the token: the
 * redactor knows it (env.ts), and no line prints headers.
 */
import { createLogger } from '../logger.js'
import { loadEnv } from '../../config/env.js'

const log = createLogger('platform', 'discord')

const API = 'https://discord.com/api/v10'
const TIMEOUT_MS = 15_000
const BACKOFF_MS = [1_000, 2_000, 4_000] as const
const BREAKER_THRESHOLD = 3
const BREAKER_OPEN_MS = 60_000
/** Discord's hard limit per message; bodies are split at line boundaries below it. */
export const MAX_CONTENT = 2_000
/** Discord's "Cannot send messages to this user". */
const CODE_DM_CLOSED = 50007

type FailureKind = 'TIMEOUT' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'REJECTED'

export class DiscordSendError extends Error {
  readonly kind: FailureKind
  readonly retryable: boolean
  constructor(kind: FailureKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DiscordSendError'
    this.kind = kind
    this.retryable = kind !== 'REJECTED'
  }
}

let consecutiveFailures = 0
let breakerOpenedAt: number | null = null
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Test seams. */
export function resetDiscordBreaker(): void { consecutiveFailures = 0; breakerOpenedAt = null }
export function setDiscordSleeper(fn: (ms: number) => Promise<void>): void { sleep = fn }

export function discordConfigured(): boolean {
  const env = loadEnv()
  return env.DISCORD_BOT_TOKEN !== undefined && env.DISCORD_GUILD_ID !== undefined
}

function breakerOpen(): boolean {
  if (breakerOpenedAt === null) return false
  if (Date.now() - breakerOpenedAt >= BREAKER_OPEN_MS) {
    breakerOpenedAt = null
    consecutiveFailures = 0
    return false
  }
  return true
}

function recordFailure(): void {
  consecutiveFailures += 1
  if (consecutiveFailures === BREAKER_THRESHOLD) {
    breakerOpenedAt = Date.now()
    log.warn('discord circuit breaker opened', { consecutiveFailures })
  }
}

export async function call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const env = loadEnv()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API}${path}`, {
      method: init.method,
      headers: {
        // The token is never logged: the redactor knows it (env.ts), and nothing here prints headers.
        authorization: `Bot ${env.DISCORD_BOT_TOKEN ?? ''}`,
        'content-type': 'application/json',
        'user-agent': 'Crucible (event delivery, 1.0)',
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })
    if (!res.ok) throw await httpFailure(res)
    return (await res.json().catch(() => ({}))) as T
  } catch (err) {
    if (err instanceof DiscordSendError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DiscordSendError('TIMEOUT', `Discord did not answer within ${TIMEOUT_MS / 1000}s.`, err)
    }
    throw new DiscordSendError('UNAVAILABLE', 'Discord could not be reached.', err)
  } finally {
    clearTimeout(timer)
  }
}

async function httpFailure(res: Response): Promise<DiscordSendError> {
  const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string; retry_after?: number }
  const said = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
  if (res.status === 429) return new DiscordSendError('RATE_LIMITED', `Discord asked for a pause: ${said}`)
  if (res.status >= 500) return new DiscordSendError('UNAVAILABLE', `Discord is unavailable: ${said}`)
  if (body.code === CODE_DM_CLOSED) {
    return new DiscordSendError('REJECTED', 'Discord refused: this user does not accept DMs from the event server.')
  }
  if (res.status === 403 || res.status === 404) {
    return new DiscordSendError('REJECTED', `Discord refused: ${said}`)
  }
  return new DiscordSendError('REJECTED', `Discord rejected the message: ${said}`)
}

/** Retry the retryable, behind the breaker. Shared by the DM and the lookup. */
export async function withRetries<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (breakerOpen()) {
    throw new DiscordSendError('UNAVAILABLE',
      'Discord failed three times in a row and is being rested for a minute.')
  }
  let last: DiscordSendError | null = null
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    try {
      const result = await fn()
      consecutiveFailures = 0
      return result
    } catch (err) {
      const failure = err instanceof DiscordSendError
        ? err : new DiscordSendError('UNAVAILABLE', 'Discord could not be reached.', err)
      if (failure.retryable) recordFailure()
      last = failure
      if (!failure.retryable || attempt === BACKOFF_MS.length - 1) break
      log.info('discord retry', { what, attempt: attempt + 1, kind: failure.kind })
      await sleep(BACKOFF_MS[attempt]!)
    }
  }
  throw last ?? new DiscordSendError('UNAVAILABLE', 'Discord could not be reached.')
}

