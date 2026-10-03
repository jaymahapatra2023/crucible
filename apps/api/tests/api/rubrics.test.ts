/**
 * Rubric route contract tests (E02-S06, E02-S07, E02-S08, P8.1).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { createChallenge } from '../../src/modules/challenges/services/challengeService.js'
import { createVersion } from '../../src/modules/rubrics/services/rubricService.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import type { Dimension } from '@crucible/rubric'

let app: FastifyInstance
let organiser: TestUser
let viewer: TestUser
let challengeId: number
let rubricId: number

const ACTOR = 'organiser@test.local'
const anchors = { 0: 'none', 1: 'named', 2: 'unused', 3: 'works', 4: 'tested' }
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'api' }, fn)

function criterionInput(name: string, dimension: Dimension, weight: number, sortOrder: number) {
  return {
    dimension, name, description: `Whether the submission ${name.toLowerCase()}.`, weight,
    evidenceSpec: 'A reader can point to the implementing code.', anchors,
    sourceRef: dimension === 'CHALLENGE_FIDELITY' ? 'brief §2.1' : null,
    sortOrder,
  }
}

const FIDELITY_ONLY = {
  CHALLENGE_FIDELITY: 1, ENGINEERING_QUALITY: 0, PRINCIPLES_STANDARDS: 0, RUNS: 0, ORIGINALITY: 0,
}

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  app = await getApp()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')

  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  challengeId = challenge.challengeId
  const rubric = await inScope(() => createVersion({
    challengeId,
    criteria: [
      criterionInput('Ingests the feed', 'CHALLENGE_FIDELITY', 0.6, 0),
      criterionInput('Detects breaches', 'CHALLENGE_FIDELITY', 0.4, 1),
    ],
    actor: ACTOR,
  }))
  rubricId = Number(rubric.rubricId)
})

afterAll(async () => closeApp())

const asOrganiser = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: authHeader(organiser), ...(payload !== undefined && { payload }) })

async function makeApprovable() {
  const res = await asOrganiser('PUT', `/api/v1/rubrics/${rubricId}/dimension-weights`,
    { weights: FIDELITY_ONLY })
  expect(res.statusCode).toBe(200)
}

describe('reading', () => {
  it('lists rubric versions for a challenge', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/challenges/${challengeId}/rubrics`, headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: unknown[] }).data).toHaveLength(1)
  })

  it('returns a readiness report naming what blocks approval', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/rubrics/${rubricId}/readiness`, headers: authHeader(viewer),
    })
    const data = (res.json() as {
      data: {
        canApprove: boolean
        unacknowledgedWarnings: string[]
        report: { errors: Array<{ code: string }>; warnings: Array<{ code: string }> }
      }
    }).data

    // The default dimension weights already sum to 1, so nothing is in *error*. What blocks
    // approval is that four weighted dimensions have no criteria yet — a warning the reviewer
    // must see and acknowledge rather than approve past (E02-S06 acceptance 4).
    expect(data.report.errors).toEqual([])
    expect(data.canApprove).toBe(false)
    expect(data.unacknowledgedWarnings).toContain('DIMENSION_WEIGHTED_BUT_EMPTY')
  })

  it('reports the next version before any work is spent', async () => {
    const res = await asOrganiser('GET', `/api/v1/challenges/${challengeId}/rubrics/next-version`)
    expect((res.json() as { data: { nextVersion: number } }).data.nextVersion).toBe(2)
  })
})

describe('editing (E02-S06)', () => {
  it('adds a criterion', async () => {
    const res = await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/criteria`, {
      dimension: 'ENGINEERING_QUALITY', name: 'Has tests',
      description: 'Whether the submission carries tests.', weight: 1,
      evidenceSpec: 'A reader can point to test files.', anchors,
    })
    expect(res.statusCode).toBe(201)
  })

  it('rejects a criterion missing anchors', async () => {
    const res = await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/criteria`, {
      dimension: 'ENGINEERING_QUALITY', name: 'Has tests', weight: 1,
      evidenceSpec: 'x', anchors: { 0: 'a', 1: 'b', 2: 'c' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a CHALLENGE_FIDELITY criterion with no source_ref, at the database level', async () => {
    const res = await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/criteria`, {
      dimension: 'CHALLENGE_FIDELITY', name: 'Untraceable requirement',
      description: 'No provenance.', weight: 1,
      evidenceSpec: 'A reader can point to something.', anchors,
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('edits, reorders and removes criteria', async () => {
    const list = (await app.inject({
      method: 'GET', url: `/api/v1/rubrics/${rubricId}`, headers: authHeader(viewer),
    })).json() as { data: { criteria: Array<{ criterionId: string }> } }
    const ids = list.data.criteria.map((c) => Number(c.criterionId))

    expect((await asOrganiser('PATCH', `/api/v1/rubrics/${rubricId}/criteria/${ids[0]}`,
      { name: 'Ingests the telemetry feed' })).statusCode).toBe(200)
    expect((await asOrganiser('PUT', `/api/v1/rubrics/${rubricId}/criteria/order`,
      { order: [...ids].reverse() })).statusCode).toBe(200)
    expect((await asOrganiser('DELETE', `/api/v1/rubrics/${rubricId}/criteria/${ids[1]}`)).statusCode).toBe(204)
  })

  it('rejects an empty edit rather than making a no-op audit entry', async () => {
    const list = (await app.inject({
      method: 'GET', url: `/api/v1/rubrics/${rubricId}`, headers: authHeader(viewer),
    })).json() as { data: { criteria: Array<{ criterionId: string }> } }
    const res = await asOrganiser('PATCH',
      `/api/v1/rubrics/${rubricId}/criteria/${list.data.criteria[0]!.criterionId}`, {})
    expect(res.statusCode).toBe(400)
  })

  it('sets weights for a whole dimension', async () => {
    const list = (await app.inject({
      method: 'GET', url: `/api/v1/rubrics/${rubricId}`, headers: authHeader(viewer),
    })).json() as { data: { criteria: Array<{ criterionId: string }> } }
    const [a, b] = list.data.criteria

    const res = await asOrganiser('PUT', `/api/v1/rubrics/${rubricId}/criteria/weights`, {
      dimension: 'CHALLENGE_FIDELITY',
      weights: { [a!.criterionId]: 0.7, [b!.criterionId]: 0.3 },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('approve, freeze, publish (E02-S07, E02-S08)', () => {
  it('walks the full lifecycle', async () => {
    await makeApprovable()
    expect((await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/approve`,
      { acknowledgedWarnings: ['DIMENSION_WEIGHTED_BUT_EMPTY'] })).statusCode).toBe(200)

    const frozen = await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/freeze`)
    expect(frozen.statusCode).toBe(200)
    expect((frozen.json() as { data: { contentHash: string } }).data.contentHash).toMatch(/^[0-9a-f]{64}$/)

    expect((await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/publish`)).statusCode).toBe(200)
  })

  it('refuses approval while a warning is unacknowledged (acceptance 4)', async () => {
    const res = await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/approve`)
    expect(res.statusCode).toBe(412)
    expect((res.json() as { error: { code: string } }).error.code).toBe('PRECONDITION_FAILED')
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/acknowledged/)
  })

  it('refuses approval outright when weights do not sum to 1.0 (acceptance 2)', async () => {
    await makeApprovable()
    const list = (await app.inject({
      method: 'GET', url: `/api/v1/rubrics/${rubricId}`, headers: authHeader(viewer),
    })).json() as { data: { criteria: Array<{ criterionId: string }> } }
    const [a, b] = list.data.criteria
    await asOrganiser('PUT', `/api/v1/rubrics/${rubricId}/criteria/weights`, {
      dimension: 'CHALLENGE_FIDELITY',
      weights: { [a!.criterionId]: 0.5, [b!.criterionId]: 0.2 },
    })

    const res = await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/approve`,
      { acknowledgedWarnings: ['DIMENSION_WEIGHTED_BUT_EMPTY'] })
    expect(res.statusCode).toBe(422)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/sum to 0\.7000/)
  })

  it('refuses every edit after freeze', async () => {
    await makeApprovable()
    await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/approve`,
      { acknowledgedWarnings: ['DIMENSION_WEIGHTED_BUT_EMPTY'] })
    await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/freeze`)

    const res = await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/criteria`, {
      dimension: 'ENGINEERING_QUALITY', name: 'Sneaky addition',
      description: 'Added after freeze.', weight: 1,
      evidenceSpec: 'A reader can point to something.', anchors,
    })
    expect(res.statusCode).toBe(409)
  })

  it('a viewer cannot approve, freeze or publish', async () => {
    await makeApprovable()
    for (const verb of ['approve', 'freeze', 'publish']) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/rubrics/${rubricId}/${verb}`, headers: authHeader(viewer),
      })
      expect(res.statusCode, verb).toBe(403)
    }
  })
})

describe('export and publication (E02-S08)', () => {
  beforeEach(async () => {
    await makeApprovable()
    await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/approve`,
      { acknowledgedWarnings: ['DIMENSION_WEIGHTED_BUT_EMPTY'] })
    await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/freeze`)
    await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/publish`)
  })

  it('exports Markdown carrying version and hash', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/rubrics/${rubricId}/export.md`, headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/markdown')
    expect(res.body).toContain('**Version 1**')
    expect(res.body).toMatch(/Content hash: `[0-9a-f]{64}`/)
  })

  it('exports HTML', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/rubrics/${rubricId}/export.html`, headers: authHeader(viewer),
    })
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body.startsWith('<!doctype html>')).toBe(true)
  })

  it('serves the published rubric WITHOUT authentication — teams have no account (P8.1)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/rubrics/published/challenge-alpha' })
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: { status: string; criteria: unknown[] } }).data
    expect(data.status).toBe('FROZEN')
    expect(data.criteria.length).toBeGreaterThan(0)
  })

  it('serves HTML to a browser Accept header', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/rubrics/published/challenge-alpha',
      headers: { accept: 'text/html' },
    })
    expect(res.body.startsWith('<!doctype html>')).toBe(true)
  })

  it('404s for a challenge with nothing published', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/rubrics/published/no-such-challenge' })
    expect(res.statusCode).toBe(404)
  })
})

describe('creating a new version (E02-S07)', () => {
  it('creates an empty draft when nothing is copied', async () => {
    const res = await asOrganiser('POST', `/api/v1/challenges/${challengeId}/rubrics`)
    expect(res.statusCode).toBe(201)
    const { data } = res.json() as { data: { version: number; status: string; criteria: unknown[] } }
    expect(data.status).toBe('DRAFT')
    expect(data.version).toBe(2)
    expect(data.criteria).toEqual([])
  })

  it('carries the source version\'s criteria and weights forward', async () => {
    // A committee told "this is frozen, create a new version to change it" wants to adjust one
    // weight, not retype the rubric. An empty draft turns a correction into a rewrite, and a
    // rewritten rubric is not comparable with the one teams were shown.
    await asOrganiser('PUT', `/api/v1/rubrics/${rubricId}/dimension-weights`,
      { weights: FIDELITY_ONLY })

    const res = await asOrganiser('POST', `/api/v1/challenges/${challengeId}/rubrics`,
      { copyFrom: rubricId })
    expect(res.statusCode).toBe(201)

    const { data } = res.json() as {
      data: {
        status: string
        dimensionWeights: Record<string, number>
        criteria: Array<{ name: string; weight: number; evidenceSpec: string }>
      }
    }
    expect(data.status).toBe('DRAFT')
    expect(data.criteria.map((c) => c.name).sort())
      .toEqual(['Detects breaches', 'Ingests the feed'])
    expect(data.dimensionWeights).toMatchObject(FIDELITY_ONLY)
    // The evidence specification comes too — without it the copy is not scoreable.
    expect(data.criteria.every((c) => c.evidenceSpec.length > 0)).toBe(true)
  })

  it('leaves the source version untouched', async () => {
    await asOrganiser('POST', `/api/v1/challenges/${challengeId}/rubrics`, { copyFrom: rubricId })
    const source = await asOrganiser('GET', `/api/v1/rubrics/${rubricId}`)
    expect((source.json() as { data: { status: string } }).data.status).toBe('DRAFT')
  })

  it('can be copied from a FROZEN version — that is the point of it', async () => {
    await makeApprovable()
    await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/approve`, { acknowledgedWarnings: [] })
    await asOrganiser('POST', `/api/v1/rubrics/${rubricId}/freeze`)

    const res = await asOrganiser('POST', `/api/v1/challenges/${challengeId}/rubrics`,
      { copyFrom: rubricId })
    expect(res.statusCode).toBe(201)
    expect((res.json() as { data: { criteria: unknown[] } }).data.criteria).toHaveLength(2)
  })

  it('refuses to copy from another challenge\'s rubric', async () => {
    const other = await inScope(() => createChallenge({ name: 'Challenge Beta', actor: ACTOR }))
    const res = await asOrganiser('POST', `/api/v1/challenges/${other.challengeId}/rubrics`,
      { copyFrom: rubricId })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: { message: expect.stringMatching(/belongs to a different challenge/i) },
    })
  })

  it('refuses a viewer — a new version changes what teams are judged by', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/challenges/${challengeId}/rubrics`,
      headers: authHeader(viewer), payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('404s a copyFrom that does not exist', async () => {
    const res = await asOrganiser('POST', `/api/v1/challenges/${challengeId}/rubrics`,
      { copyFrom: 999999 })
    expect(res.statusCode).toBe(404)
  })
})
