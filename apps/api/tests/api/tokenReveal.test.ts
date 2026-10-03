/**
 * The reveal endpoint (E47-S02, ADR 0005): admin-only, behind its own ceiling, and a 200 that
 * says "unavailable" is an answer, not an error.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetRateLimit } from '../../src/http/rateLimit.js'
import { resetRevealKey, setRevealKey } from '../../src/lib/tokenCipher.js'
import { issueSubmissionToken } from '../../src/modules/submissions/services/submissionTokens.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let app: FastifyInstance
let admin: TestUser
let organiser: TestUser
let issued: { tokenId: number; token: string; teamId: number }

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetRateLimit()
  setRevealKey(randomBytes(32).toString('base64'))
  app = await getApp()
  admin = await makeUser('admin')
  organiser = await makeUser('organiser')
  issued = await withCorrelation({ correlationId: 'seed' }, () => issueSubmissionToken({
    label: 'Team Alpha', contactEmail: 'alpha@test.local', issuedBy: 'seed',
  }))
})

afterEach(() => resetRevealKey())
afterAll(async () => { await closeApp() })

const reveal = (user: TestUser, id = issued.tokenId) => app.inject({
  method: 'POST', url: `/api/v1/submissions/tokens/${id}/reveal`, headers: authHeader(user),
})

describe('POST /submissions/tokens/:id/reveal', () => {
  it('returns the code to an admin', async () => {
    const res = await reveal(admin)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { available: boolean; token: string } }>().data)
      .toMatchObject({ available: true, token: issued.token })
  })

  it('is NOT an organiser act — the role that issues is not the role that reads back', async () => {
    expect((await reveal(organiser)).statusCode).toBe(403)
  })

  it('answers 200 with a reason when there is nothing to reveal', async () => {
    setRevealKey(null)
    const res = await reveal(admin)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { available: boolean; reason: string } }>().data)
      .toMatchObject({ available: false, reason: expect.stringMatching(/reveal key/) })
  })

  it('sits behind its own ceiling, per credential', async () => {
    await setConfig('http.ceiling_token_reveal_per_hour', 2, 'test')
    invalidateConfig()
    expect((await reveal(admin)).statusCode).toBe(200)
    expect((await reveal(admin)).statusCode).toBe(200)
    expect((await reveal(admin)).statusCode).toBe(429)
  })

  it('404s for a token that does not exist', async () => {
    expect((await reveal(admin, 999_999)).statusCode).toBe(404)
  })

  it('marks the token revealable on the listing, and not once revoked', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/submissions/tokens', headers: authHeader(organiser) })
    expect(before.json<{ data: Array<{ tokenId: number; revealable: boolean }> }>().data
      .find((t) => t.tokenId === issued.tokenId)?.revealable).toBe(true)
    await app.inject({ method: 'DELETE', url: `/api/v1/submissions/tokens/${issued.tokenId}`, headers: authHeader(organiser) })
    const after = await app.inject({ method: 'GET', url: '/api/v1/submissions/tokens', headers: authHeader(organiser) })
    expect(after.json<{ data: Array<{ tokenId: number; revealable: boolean }> }>().data
      .find((t) => t.tokenId === issued.tokenId)?.revealable).toBe(false)
  })
})
