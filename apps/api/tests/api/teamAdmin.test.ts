/**
 * Team administration endpoints (E47-S01, E48-S01): organiser-only, and the reissue answer
 * carries the new plaintext for the one moment it exists.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { issueSubmissionToken } from '../../src/modules/submissions/services/submissionTokens.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let app: FastifyInstance
let organiser: TestUser
let viewer: TestUser
let teamId: number

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  app = await getApp()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')
  const issued = await withCorrelation({ correlationId: 'seed' }, () => issueSubmissionToken({
    label: 'Team Alpha', contactEmail: 'alpha@test.local', issuedBy: 'seed',
  }))
  teamId = issued.teamId
})

afterAll(async () => { await closeApp() })

describe('PATCH /submissions/teams/:id', () => {
  it('renames for an organiser', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/submissions/teams/${teamId}`,
      headers: authHeader(organiser), payload: { displayName: 'Team Alpha Prime' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { displayName: string } }>().data.displayName).toBe('Team Alpha Prime')
  })

  it('is not a viewer act', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/submissions/teams/${teamId}`,
      headers: authHeader(viewer), payload: { displayName: 'X Y' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses an empty change rather than silently doing nothing', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/submissions/teams/${teamId}`,
      headers: authHeader(organiser), payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a colliding name and names the clash', async () => {
    await withCorrelation({ correlationId: 'seed' }, () => issueSubmissionToken({
      label: 'Team Beta', contactEmail: 'beta@test.local', issuedBy: 'seed',
    }))
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/submissions/teams/${teamId}`,
      headers: authHeader(organiser), payload: { displayName: 'team beta' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { message: string } }>().error.message).toContain('"Team Beta"')
  })
})

describe('POST /submissions/teams/:id/reissue', () => {
  it('answers 201 with the new code and how many it stopped', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/submissions/teams/${teamId}/reissue`,
      headers: authHeader(organiser), payload: { reason: 'team lost it' },
    })
    expect(res.statusCode).toBe(201)
    const data = res.json<{ data: { token: string; teamId: number; revoked: number } }>().data
    expect(data.token).toMatch(/^crs_/)
    expect(data.teamId).toBe(teamId)
    expect(data.revoked).toBe(1)
  })

  it('needs a reason', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/submissions/teams/${teamId}/reissue`,
      headers: authHeader(organiser), payload: { reason: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('is not a viewer act', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/submissions/teams/${teamId}/reissue`,
      headers: authHeader(viewer), payload: { reason: 'lost' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404s for a team that does not exist', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/teams/999999/reissue',
      headers: authHeader(organiser), payload: { reason: 'lost' },
    })
    expect(res.statusCode).toBe(404)
  })
})
