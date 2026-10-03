/**
 * Sealing and opening submission tokens (E47-S02, ADR 0005).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { openToken, resetRevealKey, revealKeyId, sealToken, setRevealKey } from './tokenCipher.js'

const KEY = randomBytes(32).toString('base64')
const OTHER = randomBytes(32).toString('base64')

afterEach(() => resetRevealKey())

describe('with a key', () => {
  it('round-trips, and two seals of one token differ (fresh IV each time)', () => {
    setRevealKey(KEY)
    const a = sealToken('crs_secret', 'token:1')!
    const b = sealToken('crs_secret', 'token:1')!
    expect(a.cipher).not.toBe(b.cipher)
    expect(openToken(a, 'token:1')).toEqual({ available: true, plaintext: 'crs_secret' })
    expect(a.keyId).toBe(revealKeyId())
  })

  it('refuses a ciphertext moved to another row', () => {
    setRevealKey(KEY)
    const sealed = sealToken('crs_secret', 'token:1')!
    expect(openToken(sealed, 'token:2').available).toBe(false)
  })

  it('refuses an altered ciphertext, with a reason rather than a throw', () => {
    setRevealKey(KEY)
    const sealed = sealToken('crs_secret', 'token:1')!
    const parts = sealed.cipher.split(':')
    parts[3] = Buffer.from('tampered').toString('base64')
    const opened = openToken({ ...sealed, cipher: parts.join(':') }, 'token:1')
    expect(opened).toMatchObject({ available: false, reason: expect.stringMatching(/did not authenticate/) })
  })

  it('reports a rotated key as unavailable rather than failing to decrypt', () => {
    setRevealKey(KEY)
    const sealed = sealToken('crs_secret', 'token:1')!
    setRevealKey(OTHER)
    expect(openToken(sealed, 'token:1')).toMatchObject({ available: false, reason: expect.stringMatching(/different reveal key/) })
  })

  it('never puts the plaintext or the key in the stored form', () => {
    setRevealKey(KEY)
    const sealed = sealToken('crs_secret', 'token:1')!
    expect(sealed.cipher).not.toContain('crs_secret')
    expect(sealed.cipher).not.toContain(KEY)
    expect(sealed.keyId).not.toContain(KEY)
    expect(sealed.keyId).toHaveLength(12)
  })
})

describe('without a key', () => {
  it('seals nothing and says why on open', () => {
    setRevealKey(null)
    expect(sealToken('crs_secret', 'token:1')).toBeNull()
    expect(revealKeyId()).toBeNull()
    expect(openToken({ cipher: 'v1:a:b:c', keyId: 'x' }, 'token:1'))
      .toMatchObject({ available: false, reason: expect.stringMatching(/No reveal key/) })
  })
})
