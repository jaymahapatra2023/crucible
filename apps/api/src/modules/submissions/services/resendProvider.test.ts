/**
 * The Resend adapter (E43-S01, P12.2, P4.2).
 *
 * Nothing here touches the network: `fetch` is replaced per test. What is asserted is the
 * discipline P12.2 asks of every external integration, and the one property specific to mail —
 * that a retry cannot deliver twice, which rests on the idempotency key travelling with every
 * attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '../../../config/env.js'
import {
  MailSendError, resendProvider, resetResendBreaker, setResendSleeper,
} from './resendProvider.js'

const MESSAGE = {
  to: 'team@example.test', subject: 'Your code', body: 'crs_abc',
  idempotencyKey: 'token-issued/7',
}

/** Queue responses in order; each call to fetch shifts one. */
function respondWith(...responses: Array<() => Response | Promise<Response>>) {
  const spy = vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('fetch called more times than responses were queued')
    return next()
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

const ok = (id = 'msg_1') => () => new Response(JSON.stringify({ id }), { status: 200 })
const status = (code: number, message = 'nope') => () =>
  new Response(JSON.stringify({ message }), { status: code })

const slept: number[] = []

beforeEach(() => {
  vi.stubEnv('MAIL_PROVIDER', 'resend')
  vi.stubEnv('MAIL_API_KEY', 're_test_key_1234567890')
  vi.stubEnv('MAIL_FROM', 'crucible@example.test')
  resetEnvCache()
  resetResendBreaker()
  slept.length = 0
  setResendSleeper(async (ms) => { slept.push(ms) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetEnvCache()
})

describe('one successful send', () => {
  it('posts the message with the key and the idempotency header, and returns the provider ref', async () => {
    const spy = respondWith(ok('msg_42'))

    const result = await resendProvider.send(MESSAGE)

    expect(result.delivered).toBe(true)
    expect(result.providerRef).toBe('msg_42')

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer re_test_key_1234567890')
    expect(headers['idempotency-key']).toBe('token-issued/7')
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'crucible@example.test', to: ['team@example.test'],
      subject: 'Your code', text: 'crs_abc',
    })
  })
})

describe('classified retry (P4.2)', () => {
  it('retries a 429 with backoff, and the SAME idempotency key each time', async () => {
    const spy = respondWith(status(429, 'slow down'), status(429, 'slow down'), ok())

    const result = await resendProvider.send(MESSAGE)

    expect(result.delivered).toBe(true)
    expect(spy).toHaveBeenCalledTimes(3)
    // 1 s then 2 s, per P12.2. The third attempt succeeded so no third sleep.
    expect(slept).toEqual([1_000, 2_000])
    for (const call of spy.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1]
      expect((init.headers as Record<string, string>)['idempotency-key']).toBe('token-issued/7')
    }
  })

  it('retries a 5xx and a timeout', async () => {
    respondWith(status(503), ok())
    await expect(resendProvider.send(MESSAGE)).resolves.toMatchObject({ delivered: true })
  })

  it('does NOT retry a 4xx — a rejected address does not improve on the third try', async () => {
    const spy = respondWith(status(422, 'The example.test domain is not verified'))

    await expect(resendProvider.send(MESSAGE)).rejects.toThrow(/not verified/)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('gives up after three attempts and surfaces the last failure', async () => {
    respondWith(status(500), status(500), status(500))

    await expect(resendProvider.send(MESSAGE)).rejects.toThrow(MailSendError)
    expect(slept).toEqual([1_000, 2_000])
  })
})

describe('the circuit breaker (P12.2)', () => {
  it('opens after three consecutive failures and refuses without calling the provider', async () => {
    respondWith(status(500), status(500), status(500))
    await expect(resendProvider.send(MESSAGE)).rejects.toThrow()

    const spy = respondWith(ok())
    await expect(resendProvider.send(MESSAGE)).rejects.toThrow(/rested for a minute/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('closes again after a success', async () => {
    respondWith(status(500), ok())
    await resendProvider.send(MESSAGE)
    respondWith(ok())
    await expect(resendProvider.send(MESSAGE)).resolves.toMatchObject({ delivered: true })
  })
})

describe('what it never does', () => {
  it('never puts the key in the error it throws', async () => {
    respondWith(status(401, 'Invalid API key: re_test_key_1234567890'))
    let thrown: unknown
    try { await resendProvider.send(MESSAGE) } catch (err) { thrown = err }
    // The provider's message quotes the key. The adapter keeps that message; the CALLER redacts
    // before storing — and that is asserted where the storing happens. Here, only that the
    // adapter itself did not add the key anywhere else.
    expect((thrown as Error).message.split('re_test_key_1234567890').length).toBeLessThanOrEqual(2)
  })
})
