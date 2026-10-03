/**
 * Provider adapter tests (P12.2).
 *
 * `fetch` is stubbed, so the adapter's own controls — timeout, error classification and the
 * circuit breaker — are exercised without a network. These matter: they decide whether a
 * provider wobble on evaluation night degrades one submission or stalls the whole cohort.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anthropicProvider, resetBreaker } from './anthropicProvider.js'
import { ProviderError } from './providerContract.js'
import { resetEnvCache } from '../../../config/env.js'

const REQUEST = {
  model: 'claude-sonnet-5',
  system: 'You are a judge.',
  user: 'Score this.',
  maxTokens: 1024,
  temperature: 0,
  timeoutMs: 5_000,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

const OK_BODY = {
  content: [{ type: 'text', text: '{"score":3}' }],
  usage: { input_tokens: 120, output_tokens: 40 },
  stop_reason: 'end_turn',
}

beforeEach(() => {
  resetBreaker()
  resetEnvCache()
  process.env['ANTHROPIC_API_KEY'] = 'test-api-key-value-not-real'
  process.env['DATABASE_URL'] = 'postgresql://localhost:5432/crucible_test'
  process.env['JWT_SECRET'] = 'test-only-jwt-secret-at-least-thirty-two-chars'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env['ANTHROPIC_API_KEY']
  resetEnvCache()
  resetBreaker()
})

describe('availability', () => {
  it('is available when a key is configured', () => {
    expect(anthropicProvider.isAvailable()).toBe(true)
  })

  it('is unavailable without a key, rather than failing at call time', () => {
    delete process.env['ANTHROPIC_API_KEY']
    resetEnvCache()
    expect(anthropicProvider.isAvailable()).toBe(false)
  })

  it('reports a named error when called with no key', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    resetEnvCache()
    await expect(anthropicProvider.complete(REQUEST)).rejects.toThrow(/ANTHROPIC_API_KEY is not configured/)
  })
})

describe('successful completion', () => {
  it('returns text, token usage and stop reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(OK_BODY)))
    const res = await anthropicProvider.complete(REQUEST)
    expect(res.text).toBe('{"score":3}')
    expect(res.tokensIn).toBe(120)
    expect(res.tokensOut).toBe(40)
    expect(res.stopReason).toBe('end_turn')
  })

  it('sends the system prompt and user turn separately (P8.4)', async () => {
    const spy = vi.fn(async (_u: string, _i: RequestInit) => jsonResponse(OK_BODY))
    vi.stubGlobal('fetch', spy)
    await anthropicProvider.complete(REQUEST)

    const body = JSON.parse(spy.mock.calls[0]![1].body as string) as {
      system: string; messages: Array<{ role: string; content: string }>
    }
    expect(body.system).toBe('You are a judge.')
    expect(body.messages).toEqual([{ role: 'user', content: 'Score this.' }])
  })

  it('concatenates multiple text blocks and ignores non-text blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      content: [{ type: 'text', text: '{"a":' }, { type: 'thinking' }, { type: 'text', text: '1}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })))
    expect((await anthropicProvider.complete(REQUEST)).text).toBe('{"a":1}')
  })

  it('defaults usage to zero when the provider omits it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'x' }] })))
    const res = await anthropicProvider.complete(REQUEST)
    expect(res.tokensIn).toBe(0)
    expect(res.tokensOut).toBe(0)
  })
})

describe('error classification (P4.2)', () => {
  it('maps 429 to RATE_LIMITED, which the gateway retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'slow down' } }, 429)))
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.kind).toBe('RATE_LIMITED')
    expect(err.retryable).toBe(true)
  })

  it('maps 5xx to UNAVAILABLE, which is retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'oops' } }, 503)))
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.kind).toBe('UNAVAILABLE')
    expect(err.retryable).toBe(true)
  })

  it('maps 4xx to PROVIDER_ERROR, which is NOT retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'bad model' } }, 400)))
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.kind).toBe('PROVIDER_ERROR')
    expect(err.retryable).toBe(false)
  })

  it('includes the provider message so an operator can diagnose it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'model not found' } }, 404)))
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.message).toContain('model not found')
  })

  it('handles a non-JSON error body without masking the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream exploded', { status: 502 })))
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.kind).toBe('UNAVAILABLE')
    expect(err.message).toContain('502')
  })

  it('maps an aborted request to TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }))
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.kind).toBe('TIMEOUT')
    expect(err.message).toContain('5000ms')
  })

  it('maps an unknown transport failure to PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('socket hang up') }))
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.kind).toBe('PROVIDER_ERROR')
  })
})

describe('circuit breaker (P12.2)', () => {
  it('opens after three consecutive failures and stops calling the provider', async () => {
    const spy = vi.fn(async () => jsonResponse({ error: { message: 'down' } }, 500))
    vi.stubGlobal('fetch', spy)

    for (let i = 0; i < 3; i++) {
      await anthropicProvider.complete(REQUEST).catch(() => undefined)
    }
    expect(spy).toHaveBeenCalledTimes(3)

    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err.message).toMatch(/circuit breaker is open/)
    // The fourth call never reached the network.
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('a success resets the failure count', async () => {
    let failures = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failures < 2) { failures++; return jsonResponse({ error: { message: 'x' } }, 500) }
      return jsonResponse(OK_BODY)
    }))

    await anthropicProvider.complete(REQUEST).catch(() => undefined)
    await anthropicProvider.complete(REQUEST).catch(() => undefined)
    await expect(anthropicProvider.complete(REQUEST)).resolves.toMatchObject({ text: '{"score":3}' })

    // Two more failures must not trip the breaker, because the counter was reset.
    failures = 0
    await anthropicProvider.complete(REQUEST).catch(() => undefined)
    const err = await anthropicProvider.complete(REQUEST).catch((e) => e as ProviderError)
    expect(err?.message ?? '').not.toMatch(/circuit breaker/)
  })
})
