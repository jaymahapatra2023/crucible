/**
 * Sealing a submission token so an admin can reveal it later (E47-S02, ADR 0005).
 *
 * AES-256-GCM, a fresh 96-bit IV per token, and the token's row id as additional authenticated
 * data so a ciphertext cannot be moved to another row. The key is `TOKEN_REVEAL_KEY`: without
 * it every function here says so and nothing else changes — issuing and verification never
 * touch this file's output.
 *
 * The key id stored beside each ciphertext is a hash prefix, not the key: enough to tell a
 * rotated key from a corrupt row, and useless to anyone reading the table.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { loadEnv } from '../config/env.js'

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'

/** Test seam — overrides the environment's key (or its absence) without re-validating env. */
let override: { key: Buffer | null } | null = null

export function setRevealKey(base64: string | null): void {
  override = { key: base64 === null ? null : Buffer.from(base64, 'base64') }
}

export function resetRevealKey(): void {
  override = null
}

function currentKey(): Buffer | null {
  if (override) return override.key
  const raw = loadEnv().TOKEN_REVEAL_KEY
  return raw === undefined ? null : Buffer.from(raw, 'base64')
}

/** Names the key sealing new tokens, or null when this deployment has none. */
export function revealKeyId(): string | null {
  const key = currentKey()
  return key === null ? null : keyIdOf(key)
}

const keyIdOf = (key: Buffer): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 12)

export interface Sealed {
  cipher: string
  keyId: string
}

/** Seal a plaintext, or null when no key is configured. `aad` is the row it belongs to. */
export function sealToken(plaintext: string, aad: string): Sealed | null {
  const key = currentKey()
  if (key === null) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    cipher: [VERSION, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':'),
    keyId: keyIdOf(key),
  }
}

export type Opened =
  | { available: true; plaintext: string }
  | { available: false; reason: string }

/** Open a sealed token. Every failure is a named reason, never a thrown error. */
export function openToken(sealed: { cipher: string; keyId: string }, aad: string): Opened {
  const key = currentKey()
  if (key === null) {
    return { available: false, reason: 'No reveal key is configured on this deployment (TOKEN_REVEAL_KEY).' }
  }
  if (keyIdOf(key) !== sealed.keyId) {
    return {
      available: false,
      reason: 'This code was sealed under a different reveal key than the one this deployment holds.',
    }
  }
  const [version, iv, tag, body] = sealed.cipher.split(':')
  if (version !== VERSION || !iv || !tag || !body) {
    return { available: false, reason: 'The stored ciphertext is not in a form this deployment can read.' }
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()])
    return { available: true, plaintext: plaintext.toString('utf8') }
  } catch {
    // Wrong key with a colliding id, or a row whose ciphertext was altered: either way, the
    // authentication tag refuses it, and the reason is reported rather than the failure thrown.
    return { available: false, reason: 'The stored ciphertext did not authenticate; it may have been altered.' }
  }
}
