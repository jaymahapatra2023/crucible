/**
 * Compact JWT (HS256) on node:crypto.
 *
 * Hand-rolled rather than pulled in, because the surface Crucible needs is small and fully
 * specified: sign, verify, expiry. Verification is constant-time and rejects `alg: none` and any
 * algorithm substitution — the two failure modes that make naive JWT code exploitable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface JwtClaims {
  sub: string
  role: string
  email: string
  /** Seconds since epoch. */
  exp: number
  iat: number
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64url')

const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url')

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

export function issueToken(
  claims: Omit<JwtClaims, 'exp' | 'iat'>,
  secret: string,
  ttlSeconds: number,
): string {
  const iat = Math.floor(Date.now() / 1000)
  const payload: JwtClaims = { ...claims, iat, exp: iat + ttlSeconds }
  const body = `${HEADER}.${b64url(JSON.stringify(payload))}`
  return `${body}.${sign(body, secret)}`
}

export type VerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: 'malformed' | 'bad_algorithm' | 'bad_signature' | 'expired' }

export function verifyToken(token: string, secret: string): VerifyResult {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [header, payload, signature] = parts as [string, string, string]

  // Reject algorithm substitution and `none` outright — never trust the header's claim.
  let alg: unknown
  try {
    alg = (JSON.parse(fromB64url(header).toString('utf8')) as { alg?: unknown }).alg
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (alg !== 'HS256') return { ok: false, reason: 'bad_algorithm' }

  const expected = sign(`${header}.${payload}`, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' }
  }

  let claims: JwtClaims
  try {
    claims = JSON.parse(fromB64url(payload).toString('utf8')) as JwtClaims
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, claims }
}
