/**
 * Team identity over HTTP (E17-S01 … E17-S04).
 *
 * The contract questions this epic turns on, asked at the boundary rather than at the service:
 * what a submission token can read, what it cannot, and what the submission form is given so it
 * can show a team the standard before they enter.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installFakeGit, restoreGit } from '../support/fakeGit.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import {
  createChallenge, setChallengeStatus,
} from '../../src/modules/challenges/services/challengeService.js'
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

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'teams-api' }, fn)
const anchors = { 0: 'none', 1: 'named', 2: 'unused', 3: 'works', 4: 'tested' }

const entry = (overrides: Record<string, unknown> = {}) => ({
  contactEmail: 'alpha@team.test',
  challengeId,
  repoUrl: 'https://github.com/team-alpha/project',
  buildMethod: 'COMMAND',
  buildCommand: 'npm ci',
  ...overrides,
})

async function issueFor(label: string): Promise<{ token: string; teamId: number }> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/submissions/tokens',
    headers: authHeader(organiser),
    payload: { label, contactEmail: `${label.toLowerCase().replace(/ /g, '-')}@team.test` },
  })
  const data = (res.json() as { data: { token: string; teamId: number } }).data
  return { token: data.token, teamId: data.teamId }
}

const asTeam = (payload: unknown, token: string) => app.inject({
  method: 'POST', url: '/api/v1/submissions',
  headers: { 'x-submission-token': token }, payload,
})

const mine = (token?: string) => app.inject({
  method: 'GET', url: '/api/v1/submissions/mine',
  ...(token !== undefined && { headers: { 'x-submission-token': token } }),
})

async function publishRubricFor(id: number) {
  const rubric = await inScope(() => createVersion({
    challengeId: id,
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
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installFakeGit({ '*': { files: { 'README.md': '# Project', 'Dockerfile': 'FROM node:22' } } })

  app = await getApp()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')

  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  challengeId = challenge.challengeId
  await publishRubricFor(challengeId)
  // A team can only enter an OPEN challenge, and only an OPEN one appears on the form.
  await inScope(() => setChallengeStatus(challengeId, 'OPEN', ACTOR))
  await inScope(() => openWindow({
    name: 'Event', opensAt: new Date(Date.now() - 3600_000),
    closesAt: new Date(Date.now() + 3600_000), actor: ACTOR,
  }))
})

afterAll(async () => { restoreGit(); await closeApp() })

describe('a team reading their own entry (E17-S03)', () => {
  it('returns what the team submitted', async () => {
    const alpha = await issueFor('Team Alpha')
    await asTeam(entry(), alpha.token)

    const res = await mine(alpha.token)
    expect(res.statusCode).toBe(200)
    const body = (res.json() as {
      data: { team: { displayName: string }; entries: Array<{ challengeName: string }> }
    }).data
    expect(body.team.displayName).toBe('Team Alpha')
    expect(body.entries[0]!.challengeName).toBe('Challenge Alpha')
  })

  it('CANNOT be used to read another team\'s entry (acceptance 2)', async () => {
    // There is no parameter to tamper with: the team comes from the credential. This asserts
    // the consequence — one token, one team's data — which is the property that matters.
    const alpha = await issueFor('Team Alpha')
    const beta = await issueFor('Team Beta')
    await asTeam(entry(), alpha.token)
    await asTeam(entry({ repoUrl: 'https://github.com/team-beta/project' }), beta.token)

    const body = (mineBody(await mine(beta.token)))
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]!.repoUrl).toContain('team-beta')
  })

  it('refuses with no token at all', async () => {
    expect((await mine()).statusCode).toBe(401)
  })

  it('refuses a made-up token', async () => {
    expect((await mine('crs_not-a-real-token')).statusCode).toBe(401)
  })

  it('refuses a REVOKED token immediately (P8.2)', async () => {
    const alpha = await issueFor('Team Alpha')
    await asTeam(entry(), alpha.token)

    const tokens = await app.inject({
      method: 'GET', url: '/api/v1/submissions/tokens', headers: authHeader(organiser),
    })
    const tokenId = (tokens.json() as { data: Array<{ tokenId: number }> }).data[0]!.tokenId
    await app.inject({
      method: 'DELETE', url: `/api/v1/submissions/tokens/${tokenId}`, headers: authHeader(organiser),
    })

    expect((await mine(alpha.token)).statusCode).toBe(401)
  })

  it('needs no account — it is on the allow-list, not behind a session (P8.1)', async () => {
    const alpha = await issueFor('Team Alpha')
    // No Authorization header anywhere in this request; only the team's own token.
    expect((await mine(alpha.token)).statusCode).toBe(200)
  })

  it('says what to do when the repository stopped validating (acceptance 3)', async () => {
    const alpha = await issueFor('Team Alpha')
    await asTeam(entry({ repoUrl: 'https://bitbucket.org/team/project' }), alpha.token)

    const body = mineBody(await mine(alpha.token))
    expect(body.entries[0]!.remedy).toBeTruthy()
    expect(body.entries[0]!.remedy).toMatch(/submit again/i)
  })
})

describe('the organiser\'s team surface (E17-S01)', () => {
  it('lists teams with what an organiser needs to act on', async () => {
    await issueFor('Team Alpha')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/teams', headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: Array<{ displayName: string; activeTokens: number }> }).data[0])
      .toMatchObject({ displayName: 'Team Alpha', activeTokens: 1, currentSubmissions: 0 })
  })

  it('is not readable by a viewer — a team roster is not a public list', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/teams', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('warns that a name is already taken, in all but punctuation (G13)', async () => {
    await issueFor('Night Shift')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions/teams/similar?name=The%20Night-Shift',
      headers: authHeader(organiser),
    })
    expect((res.json() as { data: Array<{ displayName: string }> }).data)
      .toEqual([expect.objectContaining({ displayName: 'Night Shift' })])
  })

  it('REFUSES to issue for a new team with no contact email', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/tokens',
      headers: authHeader(organiser), payload: { label: 'No Contact' },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/contact email is required/i)
  })

  it('returns the team the token belongs to, so the panel can name it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/tokens',
      headers: authHeader(organiser),
      payload: { label: 'Team Alpha', contactEmail: 'alpha@team.test' },
    })
    expect((res.json() as { data: { teamId: number; teamName: string } }).data)
      .toMatchObject({ teamName: 'Team Alpha' })
  })
})

describe('registering a cohort from a file (E20)', () => {
  const FILE = [
    'team_name,contact_email',
    'The Night Shift,night@team.test',
    'Daylight Robbery,day@team.test',
  ].join('\n')

  const bulk = (csv: string, confirm: boolean, user = organiser) => app.inject({
    method: 'POST', url: '/api/v1/submissions/tokens/bulk',
    headers: authHeader(user), payload: { csv, confirm },
  })

  it('plans without writing when it is not confirmed', async () => {
    const res = await bulk(FILE, false)
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: { issued: boolean; rows: unknown[] } }).data
    expect(data.issued).toBe(false)
    expect(data.rows).toHaveLength(2)

    const teams = await app.inject({
      method: 'GET', url: '/api/v1/submissions/teams', headers: authHeader(organiser),
    })
    expect((teams.json() as { data: unknown[] }).data).toHaveLength(0)
  })

  it('registers every team and returns every token when confirmed', async () => {
    const res = await bulk(FILE, true)
    const data = (res.json() as {
      data: { issued: boolean; rows: Array<{ token: string | null }> }
    }).data

    expect(data.issued).toBe(true)
    expect(data.rows.every((r) => r.token?.startsWith('crs_'))).toBe(true)
  })

  it('issues tokens that work — the whole point of the file', async () => {
    const res = await bulk(FILE, true)
    const token = (res.json() as { data: { rows: Array<{ token: string }> } }).data.rows[0]!.token

    const mineRes = await mine(token)
    expect(mineRes.statusCode).toBe(200)
    expect(mineBody(mineRes).team.displayName).toBe('The Night Shift')
  })

  it('is refused to a viewer — it creates credentials', async () => {
    expect((await bulk(FILE, false, viewer)).statusCode).toBe(403)
  })

  it('REFUSES a file with no header, naming what is missing', async () => {
    const res = await bulk('Night Shift,night@team.test', false)
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/header row is missing/)
  })

  it('refuses a body too large to be a team list before parsing it', async () => {
    const res = await bulk('x'.repeat(300_000), false)
    expect(res.statusCode).toBe(400)
  })

  it('serves the same plan as a downloadable file', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/tokens/bulk/export.csv',
      headers: authHeader(organiser), payload: { csv: FILE, confirm: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toMatch(/crucible-team-tokens\.csv/)

    const lines = res.body.trim().split('\n')
    expect(lines[0]).toBe('"team_name","contact_email","token","status"')
    expect(lines).toHaveLength(3)
    expect(res.body).toMatch(/crs_/)
  })
})

describe('issuing for every team that has none (E29-S01)', () => {
  const forTeams = (confirm: boolean, user = organiser) => app.inject({
    method: 'POST', url: '/api/v1/submissions/tokens/for-teams',
    headers: authHeader(user), payload: { confirm },
  })

  it('plans without writing, listing the teams that would get one', async () => {
    await issueFor('Team Alpha')
    await query(
      `INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ('Team Beta', 'beta@team.test', 'ORGANISER', 'fixture')`)

    const data = (await forTeams(false)).json() as {
      data: { issued: boolean; summary: { new: number; existing: number } }
    }
    // Alpha already holds one from `issueFor`; Beta does not.
    expect(data.data).toMatchObject({ issued: false })
    expect(data.data.summary).toMatchObject({ new: 1, existing: 1 })
  })

  it('issues for the teams without one, and returns each plaintext once', async () => {
    await query(
      `INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ('Team Beta', 'beta@team.test', 'ORGANISER', 'fixture')`)

    const res = await forTeams(true)
    const data = (res.json() as {
      data: { issued: boolean; rows: Array<{ token: string | null; teamName: string }> }
    }).data

    expect(data.issued).toBe(true)
    const beta = data.rows.find((r) => r.teamName === 'Team Beta')!
    expect(beta.token).toMatch(/^crs_/)
  })

  it('needs no file — that is the point of it', async () => {
    await query(
      `INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ('Team Beta', 'beta@team.test', 'ORGANISER', 'fixture')`)
    // No csv in the payload at all.
    expect((await forTeams(true)).statusCode).toBe(200)
  })

  it('is organiser-only — it creates credentials', async () => {
    expect((await forTeams(false, viewer)).statusCode).toBe(403)
  })

  it('says plainly when there are no teams yet', async () => {
    await query('DELETE FROM access_token')
    await query('DELETE FROM team')
    const data = (await forTeams(true)).json() as { data: { refusal: string } }
    expect(data.data.refusal).toMatch(/no teams yet/i)
  })
})

describe('the standard, from the form that submits to it (E17-S04)', () => {
  it('gives the submission form the slug of the published rubric', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/challenges/open' })
    const open = (res.json() as {
      data: Array<{ challengeId: number; name: string; rubricSlug: string | null }>
    }).data
    expect(open[0]).toMatchObject({ name: 'Challenge Alpha' })
    expect(open[0]!.rubricSlug).toBeTruthy()
  })

  it('that slug actually resolves the published rubric, with no account', async () => {
    // The point of the link. A slug the form shows and the public endpoint does not accept
    // would be worse than no link at all.
    const open = (await app.inject({ method: 'GET', url: '/api/v1/challenges/open' })).json() as {
      data: Array<{ rubricSlug: string }>
    }
    const res = await app.inject({
      method: 'GET', url: `/api/v1/rubrics/published/${open.data[0]!.rubricSlug}`,
    })
    expect(res.statusCode).toBe(200)
  })

  it('reports NO slug for a challenge whose rubric is not published yet', async () => {
    // Open for entries with an unpublished rubric is a state an organiser needs to see. The
    // form says so rather than offering a link that 404s.
    const second = await inScope(() => createChallenge({ name: 'Challenge Beta', actor: ACTOR }))
    await inScope(() => setChallengeStatus(second.challengeId, 'OPEN', ACTOR))

    const res = await app.inject({ method: 'GET', url: '/api/v1/challenges/open' })
    const open = (res.json() as {
      data: Array<{ challengeId: number; rubricSlug: string | null }>
    }).data
    expect(open.find((c) => c.challengeId === second.challengeId)?.rubricSlug).toBeNull()
  })

  it('lists each open challenge exactly once', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/challenges/open' })
    const ids = (res.json() as { data: Array<{ challengeId: number }> }).data
      .map((c) => c.challengeId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

const mineBody = (res: { json: () => unknown }) => (res.json() as {
  data: {
    team: { displayName: string }
    entries: Array<{ repoUrl: string; remedy: string | null }>
  }
}).data
