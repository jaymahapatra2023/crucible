/**
 * Password hashing with scrypt (node:crypto).
 *
 * Stored form is `scrypt$N$r$p$salt$hash`, so cost parameters travel with the hash and can be
 * raised later without invalidating existing credentials.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number },
) => Promise<Buffer>

const N = 16384
const R = 8
const P = 1
const KEYLEN = 32

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  try {
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const actual = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
