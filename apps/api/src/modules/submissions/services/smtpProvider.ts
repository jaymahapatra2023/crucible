/**
 * The SMTP adapter (P12.2).
 *
 * Exists because an event can need email without owning a domain. Authenticating as a mailbox
 * authorises sending as that mailbox, so a Gmail account with an app password delivers with
 * Google's reputation rather than a freshly registered domain's — no DNS, no verification wait.
 *
 * Same discipline as the Resend adapter: a timeout, three attempts with 1 s / 2 s / 4 s backoff,
 * and a breaker that opens for 60 s after three consecutive failures. Two things differ, and both
 * matter more than they look.
 *
 * **SMTP's reply codes mean the opposite of HTTP's.** 4xx is a transient refusal — try later —
 * and 5xx is permanent. Classifying them the HTTP way would retry a rejected mailbox three times
 * and give up on a greylisted one, which is exactly backwards.
 *
 * **SMTP has no idempotency key.** Resend's header makes a retry safe by construction; nothing
 * here can. So a retry is only attempted when the failure happened BEFORE the message was handed
 * over — connecting, greeting, authenticating, or the envelope. Once `DATA` has been sent the
 * outcome is ambiguous: the relay may have accepted and the acknowledgement been lost, and a
 * retry would deliver twice. A duplicate submission code is worse than a missing one, because the
 * team cannot tell which is current. So that case is reported, not retried.
 */
import { createTransport, type Transporter } from 'nodemailer'
import { createLogger } from '../../../lib/logger.js'
import { loadEnv } from '../../../config/env.js'
import type { MailMessage, MailProvider, MailResult } from '../../../lib/ports/mailPort.js'
import { MailSendError } from './resendProvider.js'

const log = createLogger('submissions', 'smtp')

const TIMEOUT_MS = 20_000
const BACKOFF_MS = [1_000, 2_000, 4_000] as const
const BREAKER_THRESHOLD = 3
const BREAKER_OPEN_MS = 60_000

/**
 * The SMTP commands after which an outcome is ambiguous.
 *
 * Nodemailer reports which command failed. Anything from `DATA` onwards may have been accepted,
 * so it is never retried.
 */
const AMBIGUOUS_COMMANDS = new Set(['DATA', 'DATA_CLOSE', '.', 'QUIT'])

let consecutiveFailures = 0
let breakerOpenedAt: number | null = null

/** Test seam — closes the breaker and forgets failures. */
export function resetSmtpBreaker(): void {
  consecutiveFailures = 0
  breakerOpenedAt = null
}

/** Test seam — the sleeper, so backoff can be observed without waiting for it. */
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
export function setSmtpSleeper(fn: (ms: number) => Promise<void>): void {
  sleep = fn
}

type SendResult = { messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }
type Sender = (message: MailMessage, from: string) => Promise<SendResult>

/**
 * Test seam — the transport. Replaced in tests so the adapter's classification, backoff and
 * breaker can be exercised without a relay, which is what there is to get right here.
 */
let sender: Sender | null = null
export function setSmtpSender(fn: Sender | null): void {
  sender = fn
  transport = null
}

let transport: Transporter | null = null

function liveTransport(): Transporter {
  if (transport) return transport
  const env = loadEnv()
  transport = createTransport({
    host: env.SMTP_HOST ?? '',
    port: env.SMTP_PORT,
    // Implicit TLS on 465; STARTTLS on 587, which nodemailer upgrades to and which it will not
    // silently skip — an unencrypted relay would send the password in the clear.
    secure: env.SMTP_SECURE === 'true',
    requireTLS: env.SMTP_SECURE !== 'true',
    auth: { user: env.SMTP_USER ?? '', pass: env.SMTP_PASSWORD ?? '' },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  })
  return transport
}

/** Forget the built transport, so a configuration change is picked up. */
export function resetSmtpTransport(): void {
  transport = null
}

function breakerOpen(): boolean {
  if (breakerOpenedAt === null) return false
  if (Date.now() - breakerOpenedAt >= BREAKER_OPEN_MS) {
    // Half-open: one attempt is allowed through to find out whether the relay recovered.
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
    log.warn('smtp circuit breaker opened', { consecutiveFailures })
  }
}

export const smtpProvider: MailProvider = {
  name: 'smtp',
  sends: true,

  async send(message: MailMessage): Promise<MailResult> {
    if (breakerOpen()) {
      throw new MailSendError('UNAVAILABLE',
        'The mail relay failed three times in a row and is being rested for a minute. '
        + 'Nothing was sent; try again shortly.')
    }

    let last: MailSendError | null = null
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      try {
        const result = await sendOnce(message)
        consecutiveFailures = 0
        return result
      } catch (err) {
        const failure = classify(err)
        recordFailure()
        last = failure
        if (!failure.retryable || attempt === BACKOFF_MS.length - 1) break
        log.info('smtp send retry', { attempt: attempt + 1, kind: failure.kind })
        await sleep(BACKOFF_MS[attempt]!)
      }
    }
    throw last ?? new MailSendError('UNAVAILABLE', 'The mail relay could not be reached.')
  },
}

async function sendOnce(message: MailMessage): Promise<MailResult> {
  const env = loadEnv()
  const from = env.MAIL_FROM ?? env.SMTP_USER ?? ''

  const send: Sender = sender ?? (async (m, f) => liveTransport().sendMail({
    from: f,
    to: m.to,
    // The rest of the team on one message (migration-free; see MailMessage.copyTo).
    ...(m.copyTo !== undefined && m.copyTo.length > 0 ? { cc: [...m.copyTo] } : {}),
    subject: m.subject,
    text: m.body,
    /*
     * Derived from the idempotency key rather than random.
     *
     * SMTP cannot promise exactly-once, but a stable Message-Id means a duplicate that does
     * happen is identifiable as one — by us in a bounce investigation, and by the receiver, many
     * of which collapse repeats of a Message-Id they have already filed.
     */
    messageId: `<${encodeURIComponent(m.idempotencyKey)}@crucible.invalid>`,
  }) as Promise<SendResult>)

  const info = await send(message, from)

  // A relay can accept the connection and refuse the recipient. Nodemailer reports that in
  // `rejected` rather than by throwing, and reporting it as delivered would be a lie.
  if (Array.isArray(info.rejected) && info.rejected.length > 0) {
    throw new MailSendError('REJECTED',
      `The relay refused ${info.rejected.join(', ')}${info.response ? `: ${info.response}` : ''}.`)
  }

  return {
    delivered: true,
    detail: `Accepted by the relay${info.response ? `: ${info.response.slice(0, 200)}` : ''}.`,
    ...(typeof info.messageId === 'string' && { providerRef: info.messageId }),
  }
}

/**
 * Classify a nodemailer error the SMTP way.
 *
 * `responseCode` is the relay's three-digit reply. 4xx is transient and worth another attempt;
 * 5xx is permanent and is not. An authentication failure is permanent whatever its code — a wrong
 * app password does not become right on the third try, and retrying it can get the mailbox locked.
 */
function classify(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err

  const e = err as { responseCode?: number; code?: string; command?: string; message?: string }
  const code = typeof e.responseCode === 'number' ? e.responseCode : undefined
  const detail = (e.message ?? 'The mail relay could not be reached.').slice(0, 300)

  return ambiguous(e, code, detail)
    ?? credentials(e, code, detail)
    ?? byReplyCode(code, detail)
    ?? byTransportCode(e, code, detail)
}

/** The message may already be delivered, so never retried. See the file header. */
function ambiguous(
  e: { command?: string }, code: number | undefined, detail: string,
): MailSendError | null {
  if (e.command === undefined || !AMBIGUOUS_COMMANDS.has(e.command)) return null
  return new MailSendError('REJECTED',
    `The relay stopped answering after the message had been handed over (${e.command}): ${detail} `
    + 'It may or may not have been delivered, so it was not retried — a duplicate submission '
    + 'code is worse than a missing one. Check the mailbox before sending again.', code)
}

/** Permanent whatever the code: a wrong app password does not come right, and retrying locks accounts. */
function credentials(
  e: { code?: string }, code: number | undefined, detail: string,
): MailSendError | null {
  if (e.code !== 'EAUTH' && code !== 535 && code !== 534) return null
  return new MailSendError('REJECTED',
    `The relay rejected the credentials: ${detail} Check SMTP_USER and SMTP_PASSWORD — a Gmail `
    + 'account needs an app password, not the account password.', code)
}

/** SMTP's own semantics: 4xx is transient, 5xx is permanent. The opposite way round from HTTP. */
function byReplyCode(code: number | undefined, detail: string): MailSendError | null {
  if (code === undefined) return null
  if (code >= 500) return new MailSendError('REJECTED', `The relay answered ${code}: ${detail}`, code)
  if (code >= 400) return new MailSendError('RATE_LIMITED', `The relay answered ${code}: ${detail}`, code)
  return null
}

function byTransportCode(
  e: { code?: string }, code: number | undefined, detail: string,
): MailSendError {
  if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || e.code === 'ECONNECTION') {
    return new MailSendError('TIMEOUT', `The relay did not answer: ${detail}`, code)
  }
  return new MailSendError('UNAVAILABLE', `The relay could not be reached: ${detail}`, code)
}
