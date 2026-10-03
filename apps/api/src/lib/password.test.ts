import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('wrong horse battery staple', hash)).toBe(false)
  })

  it('never stores the plaintext', async () => {
    const hash = await hashPassword('plaintext-should-not-appear')
    expect(hash).not.toContain('plaintext-should-not-appear')
  })

  it('produces a different hash each time (salted)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')])
    expect(a).not.toBe(b)
  })

  it('embeds cost parameters so they can be raised later', async () => {
    expect(await hashPassword('x')).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/)
  })

  it.each(['', 'not-a-hash', 'scrypt$bad', 'scrypt$a$b$c$d$e'])(
    'returns false for malformed stored value %s', async (stored) => {
      expect(await verifyPassword('anything', stored)).toBe(false)
    })
})
