/**
 * Submission intake contract tests (E03, P8.1, P8.2).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installFakeGit, restoreGit, setRepoScript, withEntry } from '../support/fakeGit.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { createChallenge } from '../../src/modules/challenges/services/challengeService.js'
import {
  approveRubric, createVersion, freezeRubric, setDimensionWeights,
} from '../../src/modules/rubrics/services/rubricService.js'
import { publishRubric } from '../../src/modules/rubrics/services/rubricExport.js'
import { openWindow } from '../../src/modules/submissions/services/windowService.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import { query } from '../../src/db/pool.js'

let app: FastifyInstance
let organiser: TestUser
let viewer: TestUser
let challengeId: number
let teamToken: string

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'sub-api' }, fn)
const anchors = { 0: 'none', 1: 'named', 2: 'unused', 3: 'works', 4: 'tested' }

const entry = (overrides: Record<string, unknown> = {}) => ({
  teamName: 'Team Alpha',
  contactEmail: 'alpha@team.test',
  challengeId,
  repoUrl: 'https://github.com/team-alpha/project',
  buildMethod: 'COMMAND',
  buildCommand: 'npm ci && npm test',
  ...overrides,
})

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installFakeGit({ '*': { files: withEntry({ 'Dockerfile': 'FROM node:22' }) } })

  app = await getApp()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')

  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  challengeId = challenge.challengeId

  const rubric = await inScope(() => createVersion({
    challengeId,
    criteria: [{
      dimension: 'CHALLENGE_FIDELITY', name: 'Solves the challenge',
      description: 'Whether the submission solves the stated problem.', weight: 1,
      evidenceSpec: 'A reader can point to the implementing code.', anchors,
      sourceRef: 'brief §1', sortOrder: 0,
    }],
    actor: ACTOR,
  }))
  const rubricId = Number(rubric.rubricId)
  await inScope(() => setDimensionWeights(rubricId, {
    CHALLENGE_FIDELITY: 1, ENGINEERING_QUALITY: 0, PRINCIPLES_STANDARDS: 0, RUNS: 0, ORIGINALITY: 0,
  }, ACTOR))
  await inScope(() => approveRubric(rubricId, ACTOR, ['DIMENSION_WEIGHTED_BUT_EMPTY']))
  await inScope(() => freezeRubric(rubricId, ACTOR))
  await inScope(() => publishRubric(rubricId, ACTOR))

  await inScope(() => openWindow({
    name: 'Event', opensAt: new Date(Date.now() - 3600_000),
    closesAt: new Date(Date.now() + 3600_000), actor: ACTOR,
  }))

  const alpha = await issueFor('Team Alpha')
  teamToken = alpha.token
})

/**
 * Issue a token, and with it the team it belongs to (E17-S01).
 *
 * A token now IS a team, so a test that wants a second team asks for a second token rather than
 * typing a different name into the form — which is precisely the change this epic made: the name
 * on the form no longer decides who is submitting.
 */
async function issueFor(label: string): Promise<{ token: string; teamId: number }> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/submissions/tokens',
    headers: authHeader(organiser),
    payload: { label, contactEmail: `${label.toLowerCase().replace(/ /g, '-')}@team.test` },
  })
  const data = (res.json() as { data: { token: string; teamId: number } }).data
  return { token: data.token, teamId: data.teamId }
}

afterEach(() => restoreGit())
afterAll(async () => closeApp())

const asTeam = (payload: unknown, token = teamToken) => app.inject({
  method: 'POST', url: '/api/v1/submissions',
  headers: { 'x-submission-token': token }, payload,
})

describe('team submission (E03-S01, P8.1, P8.2)', () => {
  it('accepts a submission authenticated by a submission token, with no account', async () => {
    const res = await asTeam(entry())
    expect(res.statusCode).toBe(201)
    expect((res.json() as { data: { validationStatus: string } }).data.validationStatus).toBe('VALID')
  })

  it('refuses a submission with no token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/submissions', payload: entry() })
    expect(res.statusCode).toBe(401)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/submission token is required/i)
  })

  it('refuses a made-up token', async () => {
    expect((await asTeam(entry(), 'crs_not-a-real-token')).statusCode).toBe(401)
  })

  it('refuses a token that is not even the right shape', async () => {
    expect((await asTeam(entry(), 'hunter2')).statusCode).toBe(401)
  })

  it('refuses a REVOKED token immediately, with no cache window (P8.2)', async () => {
    expect((await asTeam(entry())).statusCode).toBe(201)

    const tokens = await app.inject({
      method: 'GET', url: '/api/v1/submissions/tokens', headers: authHeader(organiser),
    })
    const tokenId = (tokens.json() as { data: Array<{ tokenId: number }> }).data[0]!.tokenId
    await app.inject({
      method: 'DELETE', url: `/api/v1/submissions/tokens/${tokenId}`, headers: authHeader(organiser),
    })

    const after = await asTeam(entry())
    expect(after.statusCode).toBe(401)
    expect((after.json() as { error: { message: string } }).error.message).toMatch(/revoked/)
  })

  it('never stores the token itself, only its hash (P8.3)', async () => {
    const rows = await query<{ token_hash: string }>('SELECT token_hash FROM access_token')
    expect(rows.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.rows.some((r) => r.token_hash === teamToken)).toBe(false)
  })

  it('validates the body at the boundary (P6.5)', async () => {
    // E45-S01 removed `teamName` from the body entirely, so a body that is ONLY a bad name is
    // now refused for lacking everything else. An invalid address exercises a rule that exists.
    const res = await asTeam(entry({ contactEmail: 'not-an-address' }))
    expect(res.statusCode).toBe(400)
  })

  it('reports intake status publicly, before a team has a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/submissions/status' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { state: string } }).data.state).toBe('OPEN')
  })
})

describe('organiser surface', () => {
  it('lists submissions with a real backend total', async () => {
    await asTeam(entry())
    await asTeam(entry({ teamName: 'Team Beta', repoUrl: 'https://github.com/team-beta/p' }),
      (await issueFor('Team Beta')).token)

    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions?pageSize=1', headers: authHeader(viewer),
    })
    const body = res.json() as { data: unknown[]; meta: { total: number } }
    expect(body.data).toHaveLength(1)
    expect(body.meta.total).toBe(2)
  })

  it('requires authentication to list — the team list is not public', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/submissions' })).statusCode).toBe(401)
  })

  it('lets an organiser enter a submission on a team’s behalf', async () => {
    const phoned = await issueFor('Phoned In')
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/on-behalf',
      headers: authHeader(organiser),
      payload: entry({ teamName: 'Phoned In', teamId: phoned.teamId }),
    })
    expect(res.statusCode).toBe(201)
  })

  it('REFUSES an on-behalf entry that does not say which team it is for (E17-S02)', async () => {
    // Without a token there is nothing to take identity from, so the organiser must name it.
    // Inferring the team from the typed name is exactly the behaviour this epic removed.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/on-behalf',
      headers: authHeader(organiser), payload: entry({ teamName: 'Phoned In' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('records an on-behalf entry AS on-behalf, with who made it (E17-S02 acceptance 4)', async () => {
    const phoned = await issueFor('Phoned In')
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/on-behalf',
      headers: authHeader(organiser),
      payload: entry({ teamName: 'Phoned In', teamId: phoned.teamId }),
    })
    const id = (res.json() as { data: { submissionId: number } }).data.submissionId

    const row = await query<{ submitted_via: string; submitted_by: string; token: number | null }>(
      `SELECT submitted_via, submitted_by, submitted_token_id AS token
         FROM submission WHERE submission_id = $1`, [id])
    expect(row.rows[0]).toMatchObject({ submitted_via: 'ORGANISER', submitted_by: organiser.email })
    // No token was presented, and recording one would say the team did this themselves.
    expect(row.rows[0]!.token).toBeNull()
  })

  it('exposes the validation history of one submission', async () => {
    const created = await asTeam(entry())
    const id = (created.json() as { data: { submissionId: number } }).data.submissionId
    const res = await app.inject({
      method: 'GET', url: `/api/v1/submissions/${id}/validation-history`, headers: authHeader(viewer),
    })
    expect((res.json() as { data: unknown[] }).data).toHaveLength(1)
  })

  it('denies a viewer the ability to revalidate or lock', async () => {
    const created = await asTeam(entry())
    const id = (created.json() as { data: { submissionId: number } }).data.submissionId
    for (const url of [`/api/v1/submissions/${id}/revalidate`, '/api/v1/submissions/window/lock']) {
      expect((await app.inject({ method: 'POST', url, headers: authHeader(viewer) })).statusCode).toBe(403)
    }
  })
})

describe('intake dashboard (E03-S05)', () => {
  beforeEach(async () => {
    await asTeam(entry())
    setRepoScript('team-beta', { failWith: 'fatal: repository not found' })
    await asTeam(entry({ teamName: 'Team Beta', repoUrl: 'https://github.com/team-beta/p' }),
      (await issueFor('Team Beta')).token)
  })

  it('reports counts by challenge and by status, as real backend counts', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/dashboard', headers: authHeader(viewer),
    })
    const data = (res.json() as {
      data: { totals: { total: number; valid: number }; byChallenge: unknown[] }
    }).data
    expect(data.totals).toMatchObject({ total: 2, valid: 1 })
    expect(data.byChallenge).toHaveLength(1)
  })

  it('lists failing submissions WITH the reason and the contact (acceptance 2)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/dashboard', headers: authHeader(viewer),
    })
    const failing = (res.json() as {
      data: { failing: Array<{ teamName: string; contactEmail: string; reason: string }> }
    }).data.failing

    expect(failing).toHaveLength(1)
    expect(failing[0]).toMatchObject({ teamName: 'Team Beta', contactEmail: 'alpha@team.test' })
    expect(failing[0]!.reason.length).toBeGreaterThan(10)
  })

  it('exports CSV (acceptance 3)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/export.csv', headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toMatch(/crucible-submissions\.csv/)

    const lines = res.body.trim().split('\n')
    expect(lines[0]).toContain('team_name')
    expect(lines).toHaveLength(3) // header + 2 submissions
    expect(res.body).toContain('Team Alpha')
  })

  it('neutralises spreadsheet formulas in exported team names', async () => {
    // A team name is untrusted input; an export that executes on open is a real problem.
    await query(`UPDATE submission SET team_name = '=cmd|calc' WHERE team_name = 'Team Beta'`)
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/export.csv', headers: authHeader(organiser),
    })
    expect(res.body).toContain(`"'=cmd|calc"`)
    expect(res.body).not.toContain('"=cmd|calc"')
  })

  it('denies CSV export to a viewer — it carries every team’s contact details', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/export.csv', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('ordering lists (E40)', () => {
  it('REFUSES a sort key that is not on the allow-list', async () => {
    // Silently defaulting makes a sort that did nothing look like one that worked and found
    // this order — and a free-text ORDER BY is where a list like this invites injection.
    for (const bad of ['team_name', 'submitted_at; DROP TABLE submission', '1']) {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/submissions?sort=${encodeURIComponent(bad)}`,
        headers: authHeader(viewer),
      })
      expect(res.statusCode).toBe(400)
    }
  })

  it('accepts every key it advertises', async () => {
    for (const sort of ['submitted', 'team', 'challenge', 'status', 'version']) {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/submissions?sort=${sort}`, headers: authHeader(viewer),
      })
      expect(res.statusCode).toBe(200)
    }
  })

  it('refuses an unknown token sort too', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/tokens?sort=secret',
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(400)
  })
})
