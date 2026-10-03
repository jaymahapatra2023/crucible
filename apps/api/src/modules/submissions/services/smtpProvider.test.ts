/**
 * The SMTP adapter.
 *
 * Two things here are not in the Resend adapter and are the reason this file exists.
 *
 * SMTP's reply codes mean the opposite of HTTP's: 4xx is transient, 5xx is permanent. Getting
 * that backwards would retry a rejected mailbox three times and give up on a greylisted one.
 *
 * And SMTP has no idempotency key, so a failure after the message was handed over is ambiguous —
 * it may have been delivered. Those are never retried, because a duplicate submission code is
 * worse than a missing one: a team cannot tell which of two codes is current.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '../../../config/env.js'
import {
  resetSmtpBreaker, setSmtpSender, setSmtpSleeper, smtpProvider,
} from './smtpProvider.js'
import { MailSendError } from './resendProvider.js'

const MESSAGE = {
  to: 'team@example.test',
  subject: 'Your submission code',
  body: 'Here it is.',
  idempotencyKey: 'token-issued/7',
}

/** An error shaped the way nodemailer shapes one. */
const smtpError = (over: Record<string, unknown>) => Object.assign(new Error('relay said no'), over)

beforeEach(() => {
  process.env['MAIL_PROVIDER'] = 'smtp'
  process.env['SMTP_HOST'] = 'smtp.example.test'
  process.env['SMTP_USER'] = 'sender@example.test'
  process.env['SMTP_PASSWORD'] = 'app-password'
  process.env['MAIL_FROM'] = 'sender@example.test'
  resetEnvCache()
  resetSmtpBreaker()
  setSmtpSleeper(async () => {})
})

afterEach(() => {
  setSmtpSender(null)
  resetSmtpBreaker()
  for (const k of ['MAIL_PROVIDER', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) {
    delete process.env[k]
  }
  resetEnvCache()
})

async function caught(): Promise<MailSendError> {
  try {
    await smtpProvider.send(MESSAGE)
  } catch (err) {
    if (err instanceof MailSendError) return err
    throw err
  }
  throw new Error('expected a MailSendError')
}

describe('a delivered message', () => {
  it('sends as the configured sender and returns the relay id', async () => {
    let seen: { to: string; from: string } | null = null
    setSmtpSender(async (m, from) => {
      seen = { to: m.to, from }
      return { messageId: '<abc@relay>', response: '250 2.0.0 OK' }
    })

    const result = await smtpProvider.send(MESSAGE)

    expect(result.delivered).toBe(true)
    expect(result.providerRef).toBe('<abc@relay>')
    expect(result.detail).toContain('250 2.0.0 OK')
    expect(seen).toEqual({ to: 'team@example.test', from: 'sender@example.test' })
  })

  it('reports a recipient the relay refused WITHOUT throwing as delivered', async () => {
    // Nodemailer reports a refused recipient in `rejected` rather than by throwing. Calling that
    // delivered would tell an organiser a team has its code when it does not.
    setSmtpSender(async () => ({
      messageId: '<x@relay>', rejected: ['team@example.test'], response: '550 no such user',
    }))
    const err = await caught()
    expect(err.kind).toBe('REJECTED')
    expect(err.message).toContain('team@example.test')
    expect(err.message).toContain('550 no such user')
  })
})

describe('SMTP reply codes, which are the opposite way round from HTTP', () => {
  it('retries a 4xx, because in SMTP that is transient', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(smtpError({ responseCode: 451, command: 'RCPT TO' }))
      .mockResolvedValueOnce({ messageId: '<ok@relay>' })
    setSmtpSender(send as never)

    const result = await smtpProvider.send(MESSAGE)
    expect(result.delivered).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 5xx, because in SMTP that is permanent', async () => {
    const send = vi.fn().mockRejectedValue(smtpError({ responseCode: 550, command: 'RCPT TO' }))
    setSmtpSender(send as never)

    const err = await caught()
    expect(err.kind).toBe('REJECTED')
    expect(err.retryable).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('gives up after three attempts on a persistent 4xx', async () => {
    const send = vi.fn().mockRejectedValue(smtpError({ responseCode: 421, command: 'CONN' }))
    setSmtpSender(send as never)

    await expect(smtpProvider.send(MESSAGE)).rejects.toThrow(/421/)
    expect(send).toHaveBeenCalledTimes(3)
  })
})

describe('what cannot be retried safely', () => {
  it('never retries a failure after the message was handed over', async () => {
    // The outcome is ambiguous: the relay may have accepted and the acknowledgement been lost.
    const send = vi.fn().mockRejectedValue(smtpError({ command: 'DATA', code: 'ETIMEDOUT' }))
    setSmtpSender(send as never)

    const err = await caught()
    expect(send).toHaveBeenCalledTimes(1)
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('may or may not have been delivered')
    expect(err.message).toContain('duplicate submission code is worse than a missing one')
  })

  it('does not retry bad credentials, and says what kind of password is wanted', async () => {
    const send = vi.fn().mockRejectedValue(smtpError({ code: 'EAUTH', responseCode: 535 }))
    setSmtpSender(send as never)

    const err = await caught()
    expect(send).toHaveBeenCalledTimes(1)
    expect(err.message).toContain('app password, not the account password')
  })

  it('retries a connection that never answered', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(smtpError({ code: 'ETIMEDOUT', command: 'CONN' }))
      .mockResolvedValueOnce({ messageId: '<ok@relay>' })
    setSmtpSender(send as never)

    await expect(smtpProvider.send(MESSAGE)).resolves.toMatchObject({ delivered: true })
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('the breaker', () => {
  it('opens after three consecutive failures and sends nothing while rested', async () => {
    const send = vi.fn().mockRejectedValue(smtpError({ responseCode: 421, command: 'CONN' }))
    setSmtpSender(send as never)

    await expect(smtpProvider.send(MESSAGE)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(3)

    send.mockClear()
    const err = await caught()
    expect(err.message).toContain('being rested for a minute')
    expect(err.message).toContain('Nothing was sent')
    expect(send).not.toHaveBeenCalled()
  })

  it('forgets its failures once a message gets through', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(smtpError({ responseCode: 451, command: 'CONN' }))
      .mockResolvedValue({ messageId: '<ok@relay>' })
    setSmtpSender(send as never)

    await smtpProvider.send(MESSAGE)
    await smtpProvider.send(MESSAGE)
    await smtpProvider.send(MESSAGE)
    // Three sends, one early failure, and the breaker never opened.
    expect(send).toHaveBeenCalledTimes(4)
  })
})

describe('the message id', () => {
  it('is derived from the idempotency key, so a duplicate is identifiable as one', async () => {
    // SMTP cannot promise exactly-once. A stable id means a repeat can be recognised afterwards.
    let seenId: string | undefined
    setSmtpSender(async (m) => {
      seenId = `<${encodeURIComponent(m.idempotencyKey)}@crucible.invalid>`
      return { messageId: seenId }
    })
    await smtpProvider.send(MESSAGE)
    expect(seenId).toBe('<token-issued%2F7@crucible.invalid>')
  })
})

describe('the adapter announces that it transmits', () => {
  it('is named and declares that it sends, so the delivery surface tells the truth', () => {
    expect(smtpProvider.name).toBe('smtp')
    expect(smtpProvider.sends).toBe(true)
  })
})
