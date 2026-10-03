import { describe, expect, it } from 'vitest'
import { issueToken, verifyToken } from './jwt.js'

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256'

describe('jwt', () => {
  it('round-trips claims', () => {
    const token = issueToken({ sub: '7', role: 'organiser', email: 'o@x.test' }, SECRET, 60)
    const result = verifyToken(token, SECRET)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.sub).toBe('7')
      expect(result.claims.role).toBe('organiser')
      expect(result.claims.email).toBe('o@x.test')
    }
  })

  it('rejects a token signed with a different secret', () => {
    const token = issueToken({ sub: '1', role: 'admin', email: 'a@x.test' }, SECRET, 60)
    const result = verifyToken(token, 'a-different-secret-of-sufficient-length')
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a tampered payload', () => {
    const token = issueToken({ sub: '1', role: 'viewer', email: 'v@x.test' }, SECRET, 60)
    const [h, , s] = token.split('.')
    const forged = Buffer.from(JSON.stringify({
      sub: '1', role: 'admin', email: 'v@x.test',
      exp: Math.floor(Date.now() / 1000) + 60, iat: Math.floor(Date.now() / 1000),
    })).toString('base64url')
    expect(verifyToken(`${h}.${forged}.${s}`, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects the alg:none substitution attack', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      sub: '1', role: 'admin', email: 'a@x.test',
      exp: Math.floor(Date.now() / 1000) + 60, iat: 0,
    })).toString('base64url')
    expect(verifyToken(`${header}.${payload}.`, SECRET)).toEqual({ ok: false, reason: 'bad_algorithm' })
  })

  it('rejects an expired token', () => {
    const token = issueToken({ sub: '1', role: 'viewer', email: 'v@x.test' }, SECRET, -10)
    expect(verifyToken(token, SECRET)).toEqual({ ok: false, reason: 'expired' })
  })

  it.each(['', 'a', 'a.b', 'not-a-token', 'a.b.c.d'])('rejects malformed token %s', (t) => {
    const result = verifyToken(t, SECRET)
    expect(result.ok).toBe(false)
  })
})
