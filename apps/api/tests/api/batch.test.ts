/**
 * Batch API contract (E10, P6.x, P8.1).
 *
 * The shape that matters most here is the 202: a cohort run takes hours, so the request returns
 * the run id and the caller watches progress. A synchronous response would time out at a proxy
 * long before the work finished, and the operator would not know whether it was still going.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { seedCohort, originalityTurn, scoreTurn, type CohortFixture } from '../support/scoringFixtures.js'

vi.mock('../../src/modules/scans/services/scanService.js', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/scans/services/scanService.js')>()
  return { ...actual, scanSubmission: vi.fn(async () => ({ scan: {}, skipped: false })) }
})
vi.mock('../../src/modules/probes/services/probeService.js', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/probes/services/probeService.js')>()
  return { ...actual, probeSubmission: vi.fn(async () => ({ probe: {}, skipped: false })) }
})

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser
let viewer: TestUser
let provider: FakeProvider
let cohort: CohortFixture

const start = (user: TestUser, body: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST', url: '/api/v1/batch/runs', headers: authHeader(user),
    payload: {
      challengeIds: [cohort.challengeId], cohortKey: `api-batch-${Date.now()}`, runIndex: 1,
      ...body,
    },
  })

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  app = await getApp()
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
  viewer = await makeUser('viewer')
  cohort = await seedCohort({ count: 2 })
  provider.setScript([scoreTurn(3), originalityTurn(3), scoreTurn(2), originalityTurn(3)])
})

afterEach(() => {
  restoreProviders()
  resetGateway()
  vi.clearAllMocks()
})

afterAll(async () => {
  await closeApp()
})

describe('starting a run', () => {
  it('returns 202 with the run id rather than waiting for hours of work', async () => {
    const res = await start(organiser)

    expect(res.statusCode).toBe(202)
    const { data } = res.json() as {
      data: { runId: number; scoreRunId: number; correlationId: string; message: string }
    }
    expect(data.runId).toBeGreaterThan(0)
    expect(data.scoreRunId).toBeGreaterThan(0)
    expect(data.correlationId).toBeTruthy()
    expect(data.message).toMatch(/progress/)
  })

  it('reports the cohort size and an estimate AT RUN START (E10-S02 acceptance 3)', async () => {
    const res = await start(organiser)
    const { data } = res.json() as {
      data: { subjects: number; estimatedFinishAt: string | null }
    }

    expect(data.subjects).toBe(2)
    // Null on a fresh deployment with nothing measured — the honest answer, not a guess.
    expect(data).toHaveProperty('estimatedFinishAt')
  })

  it('refuses a reviewer — a run spends money and produces the shortlist', async () => {
    expect((await start(reviewer)).statusCode).toBe(403)
  })

  it('refuses a viewer', async () => {
    expect((await start(viewer)).statusCode).toBe(403)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/batch/runs',
      payload: { cohortKey: 'x', runIndex: 1 },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a run index outside the two', async () => {
    expect((await start(organiser, { runIndex: 3 })).statusCode).toBe(400)
  })

  it('rejects a missing cohort key rather than inventing one', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/batch/runs', headers: authHeader(organiser),
      payload: { challengeIds: [cohort.challengeId], runIndex: 1 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('reports a cohort with nothing to evaluate instead of starting', async () => {
    const res = await start(organiser, { challengeIds: [999999] })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.body).toMatch(/evaluate nobody/)
  })
})

describe('progress', () => {
  it('is readable by any signed-in user', async () => {
    const started = await start(organiser)
    const { data } = started.json() as { data: { runId: number } }

    const res = await app.inject({
      method: 'GET', url: `/api/v1/batch/runs/${data.runId}/progress`,
      headers: authHeader(viewer),
    })

    expect(res.statusCode).toBe(200)
    const progress = (res.json() as { data: { stages: Array<{ stage: string }> } }).data
    // Listed even when skipped: a stage absent from the list reads as one that does not exist.
    expect(progress.stages.map((s) => s.stage))
      .toEqual(['scan', 'probe', 'discovery', 'score'])
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/batch/runs/1/progress' })
    expect(res.statusCode).toBe(401)
  })

  it('reports cost per submission as well as per run (E10-S03 acceptance 1)', async () => {
    const started = await start(organiser)
    const { data } = started.json() as { data: { runId: number } }

    const res = await app.inject({
      method: 'GET', url: `/api/v1/batch/runs/${data.runId}/progress`,
      headers: authHeader(viewer),
    })
    const progress = (res.json() as {
      data: { costBySubmission: Array<{ submissionId: number; costUsd: number }> }
    }).data

    // Shape only: the run continues in the background, so this request may arrive before the
    // first submission has been scored. What the figures contain is covered in batch.test.ts,
    // where the run can be awaited.
    expect(Array.isArray(progress.costBySubmission)).toBe(true)
  })

  it('404s a run that does not exist', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/batch/runs/999999/progress', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(404)
  })
})
