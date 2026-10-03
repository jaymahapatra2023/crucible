import { afterEach, describe, expect, it } from 'vitest'
import { clearSecrets, redact, redactString, REDACTED, registerSecrets } from './redact.js'

afterEach(() => clearSecrets())

describe('redact — by registered value (P8.3)', () => {
  it('masks a registered secret inside a plain string', () => {
    registerSecrets(['super-secret-value-123'])
    expect(redactString('connecting with super-secret-value-123 now')).toBe(`connecting with ${REDACTED} now`)
  })

  it('ignores short values, which would redact unrelated text', () => {
    registerSecrets(['abc'])
    expect(redactString('abc def')).toBe('abc def')
  })

  it('masks a secret hidden inside an error message', () => {
    registerSecrets(['tok_live_abcdefghijkl'])
    const out = redact(new Error('auth failed for tok_live_abcdefghijkl')) as { message: string }
    expect(out.message).not.toContain('tok_live_abcdefghijkl')
    expect(out.message).toContain(REDACTED)
  })

  it('masks a secret inside a nested error cause chain', () => {
    registerSecrets(['nested-secret-value'])
    const inner = new Error('upstream rejected nested-secret-value')
    const outer = new Error('request failed', { cause: inner })
    const out = JSON.stringify(redact(outer))
    expect(out).not.toContain('nested-secret-value')
  })

  it('masks a secret inside a stack trace', () => {
    registerSecrets(['stack-borne-secret-xyz'])
    const err = new Error('boom')
    err.stack = 'Error: boom\n  at thing (stack-borne-secret-xyz:1:1)'
    const out = redact(err) as { stack: string }
    expect(out.stack).not.toContain('stack-borne-secret-xyz')
  })

  it('masks a database password taken from a connection string', () => {
    registerSecrets(['p4ssw0rd-long-enough'])
    expect(redactString('postgresql://u:p4ssw0rd-long-enough@host/db')).not.toContain('p4ssw0rd')
  })
})

describe('redact — by key name', () => {
  it.each([
    'password', 'apiKey', 'api_key', 'token', 'authorization', 'secret',
    'privateKey', 'sessionId', 'cookie', 'credential',
  ])('masks the value of a field named %s', (key) => {
    const out = redact({ [key]: 'whatever-the-value-is' }) as Record<string, unknown>
    expect(out[key]).toBe(REDACTED)
  })

  it('masks sensitive keys at depth', () => {
    const out = JSON.stringify(redact({ a: { b: { c: { apiKey: 'leak-me-please' } } } }))
    expect(out).not.toContain('leak-me-please')
  })

  it('leaves non-sensitive fields intact', () => {
    expect(redact({ teamName: 'Team Alpha', score: 4 })).toEqual({ teamName: 'Team Alpha', score: 4 })
  })
})

describe('redact — robustness', () => {
  it('handles circular references without hanging', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a['self'] = a
    expect(JSON.stringify(redact(a))).toContain('[Circular]')
  })

  it('caps recursion depth', () => {
    let deep: Record<string, unknown> = { end: true }
    for (let i = 0; i < 30; i++) deep = { next: deep }
    expect(() => JSON.stringify(redact(deep))).not.toThrow()
  })

  it('summarises buffers rather than dumping them', () => {
    expect(redact(Buffer.from('abcdef'))).toBe('[Buffer 6B]')
  })

  it('handles Map, Set, Date and bigint', () => {
    expect(redact(new Map([['token', 'x'], ['ok', 'y']]))).toEqual({ token: REDACTED, ok: 'y' })
    expect(redact(new Set([1, 2]))).toEqual([1, 2])
    expect(redact(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z')
    expect(redact(10n)).toBe('10')
  })

  it('never throws on exotic input', () => {
    expect(() => redact(Symbol('s'))).not.toThrow()
    expect(() => redact(() => undefined)).not.toThrow()
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
  })
})
