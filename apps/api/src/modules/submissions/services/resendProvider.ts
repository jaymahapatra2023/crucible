/**
 * The Resend adapter (E43-S01, P12.2).
 *
 * One HTTP call: `POST https://api.resend.com/emails` with a bearer key. Everything else in this
 * file is the discipline P12.2 asks of every external integration — a timeout on the call, three
 * attempts with 1 s / 2 s / 4 s backoff, and a breaker that opens for 60 s after three consecutive
 * failures — plus one thing specific to mail:
 *
 * **A retry must not send twice.** A timeout is ambiguous: the provider may have delivered and
 * the acknowledgement was lost. Resend's `Idempotency-Key` resolves it — a repeated request with
 * the same key returns the original outcome without resending, for 24 hours. Every message
 * carries one (`MailMessage.idempotencyKey`), so a retry here is safe by construction rather than
 * by luck.
 *
 * Retries are CLASSIFIED (P4.2). A 429 or a 5xx or a timeout is retried; a 4xx is not, because a
 * rejected address does not become valid on the third attempt, and retrying it three times would
 * only burn the budget of a message that was never going to go.
 */
import { createLogger } from '../../../lib/logger.js'
import { loadEnv } from '../../../config/env.js'
import type { MailMessage, MailProvider, MailResult } from '../../../lib/ports/mailPort.js'

const log = createLogger('submissions', 'resend')

const ENDPOINT = 'https://api.resend.com/emails'
const TIMEOUT_MS = 15_000
const BACKOFF_MS = [1_000, 2_000, 4_000] as const
const BREAKER_THRESHOLD = 3
const BREAKER_OPEN_MS = 60_000

type FailureKind = 'TIMEOUT' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'REJECTED'

export class MailSendError extends Error {
  readonly kind: FailureKind
  readonly retryable: boolean
  readonly statusCode: number | undefined

  constructor(kind: FailureKind, message: string, statusCode?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MailSendError'
    this.kind = kind
    this.statusCode = statusCode
    this.retryable = kind !== 'REJECTED'
  }
}

let consecutiveFailures = 0
let breakerOpenedAt: number | null = null

/** Test seam — closes the breaker and forgets failures. */
export function resetResendBreaker(): void {
  consecutiveFailures = 0
  breakerOpenedAt = null
}

/** Test seam — the sleeper, so backoff can be observed without waiting for it. */
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
export function setResendSleeper(fn: (ms: number) => Promise<void>): void {
  sleep = fn
}

function breakerOpen(): boolean {
  if (breakerOpenedAt === null) return false
  if (Date.now() - breakerOpenedAt >= BREAKER_OPEN_MS) {
    // Half-open: one attempt is allowed through to find out whether the provider recovered.
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
    log.warn('mail circuit breaker opened', { consecutiveFailures })
  }
}

export const resendProvider: MailProvider = {
  name: 'resend',
  sends: true,

  async send(message: MailMessage): Promise<MailResult> {
    if (breakerOpen()) {
      throw new MailSendError('UNAVAILABLE',
        'The mail service failed three times in a row and is being rested for a minute. '
        + 'Nothing was sent; try again shortly.')
    }

    let last: MailSendError | null = null
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      try {
        const result = await sendOnce(message)
        consecutiveFailures = 0
        return result
      } catch (err) {
        const failure = err instanceof MailSendError
          ? err
          : new MailSendError('UNAVAILABLE', 'The mail service could not be reached.', undefined, err)
        recordFailure()
        last = failure
        // Classified (P4.2): a rejected address does not improve on the third try.
        if (!failure.retryable || attempt === BACKOFF_MS.length - 1) break
        // The key travels with every attempt, so this cannot deliver twice.
        log.info('mail send retry', { attempt: attempt + 1, kind: failure.kind })
        await sleep(BACKOFF_MS[attempt]!)
      }
    }
    throw last ?? new MailSendError('UNAVAILABLE', 'The mail service could not be reached.')
  },
}

async function sendOnce(message: MailMessage): Promise<MailResult> {
  const env = loadEnv()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        // The key is never logged: the redactor knows it (env.ts), and no line here prints headers.
        authorization: `Bearer ${env.MAIL_API_KEY ?? ''}`,
        'content-type': 'application/json',
        'idempotency-key': message.idempotencyKey,
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [message.to],
        ...(message.copyTo !== undefined && message.copyTo.length > 0
          ? { cc: [...message.copyTo] }
          : {}),
        subject: message.subject,
        text: message.body,
      }),
      signal: controller.signal,
    })

    if (!res.ok) throw await httpFailure(res)

    const body = (await res.json().catch(() => ({}))) as { id?: unknown }
    return {
      delivered: true,
      detail: 'Accepted by the mail service.',
      ...(typeof body.id === 'string' && { providerRef: body.id }),
    }
  } catch (err) {
    if (err instanceof MailSendError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MailSendError('TIMEOUT', `The mail service did not answer within ${TIMEOUT_MS} ms.`,
        undefined, err)
    }
    throw new MailSendError('UNAVAILABLE', 'The mail service could not be reached.', undefined, err)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Map a non-2xx to a classified failure.
 *
 * The provider's own message is kept, truncated, because it usually names the actual problem
 * ("domain not verified") — and it is redacted by the caller before being stored, because a
 * provider's error text routinely quotes the credential it was handed (P8.3).
 */
async function httpFailure(res: Response): Promise<MailSendError> {
  let detail = ''
  try {
    const body = (await res.json()) as { message?: unknown; name?: unknown }
    detail = typeof body.message === 'string' ? body.message : ''
  } catch {
    detail = await res.text().catch(() => '')
  }
  const message = `The mail service answered ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}.`
  if (res.status === 429) return new MailSendError('RATE_LIMITED', message, res.status)
  if (res.status >= 500) return new MailSendError('UNAVAILABLE', message, res.status)
  return new MailSendError('REJECTED', message, res.status)
}
