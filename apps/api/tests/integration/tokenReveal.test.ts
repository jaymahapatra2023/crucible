/**
 * Recoverable submission tokens (E47-S02, ADR 0005).
 *
 * The controls the ADR promises, each pinned: the hash alone verifies; the audit event lands
 * before the plaintext is opened; lock purges every stored copy; no key means "unavailable",
 * never a failure; and the plaintext never reaches a log line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { resetRevealKey, setRevealKey } from '../../src/lib/tokenCipher.js'
import { setLogLevel, setLogSink } from '../../src/lib/logger.js'
import {
  issueSubmissionToken, reissueSubmissionToken, revokeSubmissionToken, verifySubmissionToken,
} from '../../src/modules/submissions/services/submissionTokens.js'
import { purgeTokenCiphers, revealSubmissionToken } from '../../src/modules/submissions/services/tokenReveal.js'
import { lockWindow, openWindow } from '../../src/modules/submissions/services/windowService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const ADMIN = 'admin@test.local'
const KEY = randomBytes(32).toString('base64')
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'reveal' }, fn)

const issue = (label = 'Team Alpha') =>
  inScope(() => issueSubmissionToken({ label, contactEmail: 'team@test.local', issuedBy: ACTOR }))

const stored = async (tokenId: number) => (await query<{ token_cipher: string | null; cipher_purged_at: Date | null }>(
  'SELECT token_cipher, cipher_purged_at FROM access_token WHERE token_id = $1', [tokenId])).rows[0]!

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  setRevealKey(KEY)
})

afterEach(() => {
  resetRevealKey()
  setLogSink(null)
})

describe('sealing at issue', () => {
  it('stores a ciphertext beside the hash, and neither is the plaintext', async () => {
    const issued = await issue()
    const row = await query<{ token_hash: string; token_cipher: string | null }>(
      'SELECT token_hash, token_cipher FROM access_token WHERE token_id = $1', [issued.tokenId])
    expect(row.rows[0]!.token_cipher).not.toBeNull()
    expect(row.rows[0]!.token_cipher).not.toContain(issued.token)
    expect(row.rows[0]!.token_hash).not.toBe(issued.token)
  })

  it('stores nothing when no key is configured, and everything else works', async () => {
    setRevealKey(null)
    const issued = await issue()
    expect((await stored(issued.tokenId)).token_cipher).toBeNull()
    expect((await verifySubmissionToken(issued.token)).teamId).toBe(issued.teamId)
    const outcome = await inScope(() => revealSubmissionToken(issued.tokenId, ADMIN))
    expect(outcome).toMatchObject({ available: false, reason: expect.stringMatching(/without a reveal key/) })
  })

  it('verifies by the HASH alone: the ciphertext is never consulted', async () => {
    const issued = await issue()
    await query(`UPDATE access_token SET token_cipher = 'v1:garbage:garbage:garbage' WHERE token_id = $1`, [issued.tokenId])
    expect((await verifySubmissionToken(issued.token)).teamId).toBe(issued.teamId)
  })
})

describe('revealing', () => {
  it('returns the same code that was issued, and records who asked, for which team, when', async () => {
    const issued = await issue()
    const outcome = await inScope(() => revealSubmissionToken(issued.tokenId, ADMIN))
    expect(outcome).toMatchObject({ available: true, token: issued.token, teamId: issued.teamId, teamName: 'Team Alpha' })

    const audit = await query<{ actor: string; payload: { teamId: number; revealedAt: string } }>(
      `SELECT actor, payload FROM audit_event WHERE action = 'submissions.token_revealed'`)
    expect(audit.rows[0]!.actor).toBe(ADMIN)
    expect(audit.rows[0]!.payload).toMatchObject({ teamId: issued.teamId })
    expect(JSON.stringify(audit.rows[0]!.payload)).not.toContain(issued.token)
  })

  it('writes the audit event BEFORE opening, so a failed reveal is still on record', async () => {
    const issued = await issue()
    setRevealKey(randomBytes(32).toString('base64'))
    const outcome = await inScope(() => revealSubmissionToken(issued.tokenId, ADMIN))
    expect(outcome).toMatchObject({ available: false, reason: expect.stringMatching(/different reveal key/) })
    const audit = await query(`SELECT 1 FROM audit_event WHERE action = 'submissions.token_revealed'`)
    expect(audit.rows).toHaveLength(1)
  })

  it('reports a revoked code as unavailable, and its copy is already gone', async () => {
    const issued = await issue()
    await inScope(() => revokeSubmissionToken(issued.tokenId, ACTOR))
    expect((await stored(issued.tokenId)).token_cipher).toBeNull()
    const outcome = await inScope(() => revealSubmissionToken(issued.tokenId, ADMIN))
    expect(outcome).toMatchObject({ available: false, reason: expect.stringMatching(/revoked/) })
  })

  it('reissue drops the old copy and seals the new one', async () => {
    const old = await issue()
    const fresh = await inScope(() => reissueSubmissionToken({ teamId: old.teamId, reason: 'lost', actor: ACTOR }))
    expect((await stored(old.tokenId)).token_cipher).toBeNull()
    const outcome = await inScope(() => revealSubmissionToken(fresh.tokenId, ADMIN))
    expect(outcome).toMatchObject({ available: true, token: fresh.token })
  })

  it('is switched off by its flag without touching what is stored', async () => {
    const issued = await issue()
    await setFlag('feature.submissions.token_reveal', false, ACTOR)
    invalidateConfig()
    const outcome = await inScope(() => revealSubmissionToken(issued.tokenId, ADMIN))
    expect(outcome).toMatchObject({ available: false, reason: expect.stringMatching(/switched off/) })
    expect((await stored(issued.tokenId)).token_cipher).not.toBeNull()
  })

  it('never writes the plaintext to a log line', async () => {
    const lines: string[] = []
    setLogSink((line) => { lines.push(JSON.stringify(line)) })
    setLogLevel('debug')
    const issued = await issue()
    await inScope(() => revealSubmissionToken(issued.tokenId, ADMIN))
    setLogLevel('error')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(issued.token)
  })
})

describe('purging', () => {
  it('locking the intake window deletes every stored copy, audited with the count', async () => {
    const a = await issue('Team Alpha')
    const b = await issue('Team Beta')
    await inScope(() => openWindow({
      name: 'Event', opensAt: new Date(Date.now() - 3600_000), closesAt: new Date(Date.now() + 3600_000), actor: ACTOR,
    }))

    await inScope(() => lockWindow(ACTOR))

    for (const t of [a, b]) {
      const row = await stored(t.tokenId)
      expect(row.token_cipher).toBeNull()
      expect(row.cipher_purged_at).not.toBeNull()
    }
    const audit = await query<{ payload: { purged: number } }>(
      `SELECT payload FROM audit_event WHERE action = 'submissions.token_ciphers_purged'`)
    expect(audit.rows[0]!.payload.purged).toBe(2)
    // Still verifies; reveal says why it cannot.
    expect((await verifySubmissionToken(a.token)).teamId).toBe(a.teamId)
    expect(await inScope(() => revealSubmissionToken(a.tokenId, ADMIN)))
      .toMatchObject({ available: false, reason: expect.stringMatching(/purged when the intake window locked/) })
  })

  it('can be run on its own, and counts only what it removed', async () => {
    await issue()
    expect((await inScope(() => purgeTokenCiphers({ reason: 'test', actor: ADMIN }))).purged).toBe(1)
    expect((await inScope(() => purgeTokenCiphers({ reason: 'test', actor: ADMIN }))).purged).toBe(0)
  })
})
