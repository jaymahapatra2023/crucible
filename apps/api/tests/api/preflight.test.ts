/**
 * Pre-flight endpoints (E46-S02): an organiser can trigger a run for any entry, anyone signed in
 * can read the result, and the entries list carries the summary the intake screen shows.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetPreflightState } from '../../src/modules/preflight/services/preflightOrchestrator.js'
import { seedCohort, type CohortFixture } from '../support/scoringFixtures.js'
import { query } from '../../src/db/pool.js'

let app: FastifyInstance
let organiser: TestUser
let viewer: TestUser
let cohort: CohortFixture

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetPreflightState()
  app = await getApp()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')
  cohort = await seedCohort({ count: 1 })
})

afterAll(async () => { await closeApp() })

const run = (user: TestUser, id: number, payload: unknown = { force: false }) =>
  app.inject({
    method: 'POST', url: `/api/v1/preflight/submissions/${id}/run`,
    headers: authHeader(user), payload,
  })

describe('triggering a run', () => {
  it('queues a run for an organiser and answers 202 — queued, not done', async () => {
    const res = await run(organiser, cohort.submissionIds[0]!)
    expect(res.statusCode).toBe(202)
    const body = res.json<{ data: { preflightId: number; status: string; joined: boolean; message: string } }>()
    expect(body.data).toMatchObject({ status: 'QUEUED', joined: false })
    expect(body.data.message).toMatch(/queued/i)
  })

  it('joins a run already queued, and says so', async () => {
    await run(organiser, cohort.submissionIds[0]!)
    const res = await run(organiser, cohort.submissionIds[0]!)
    expect(res.statusCode).toBe(202)
    expect(res.json<{ data: { joined: boolean; message: string } }>().data).toMatchObject({ joined: true })
    expect(res.json<{ data: { message: string } }>().data.message).toMatch(/already queued/)
  })

  it('is an organiser act, not a viewer one', async () => {
    expect((await run(viewer, cohort.submissionIds[0]!)).statusCode).toBe(403)
  })

  it('refuses an entry that has not passed tier 1, naming its status', async () => {
    await query(`UPDATE submission SET validation_status = 'REJECTED'`)
    const res = await run(organiser, cohort.submissionIds[0]!)
    const body = res.json<{ error: { code: string; message: string } }>()
    expect(body.error.code).toBe('PRECONDITION_FAILED')
    expect(body.error.message).toMatch(/is REJECTED/)
  })

  it('404s for an entry that does not exist', async () => {
    expect((await run(organiser, 999_999)).statusCode).toBe(404)
  })
})

describe('reading the result', () => {
  it('returns the latest run with its notice for any signed-in role', async () => {
    await run(organiser, cohort.submissionIds[0]!)
    const res = await app.inject({
      method: 'GET', url: `/api/v1/preflight/submissions/${cohort.submissionIds[0]}`,
      headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { run: { status: string; checks: unknown[] }; notice: unknown } }>()
    expect(body.data.run.status).toBe('QUEUED')
    expect(body.data.notice).toBeNull()
  })

  it('says an entry has not been pre-flighted rather than returning nothing', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/preflight/submissions/${cohort.submissionIds[0]}`,
      headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/not been pre-flighted/)
  })

  it('carries the summary on the entries list, so the intake screen needs no second call', async () => {
    await run(organiser, cohort.submissionIds[0]!)
    const res = await app.inject({
      method: 'GET', url: '/api/v1/submissions', headers: authHeader(viewer),
    })
    const body = res.json<{ data: Array<{ submissionId: number; preflight: { status: string; attention: unknown[] } | null }> }>()
    const row = body.data.find((s) => s.submissionId === cohort.submissionIds[0])!
    expect(row.preflight).toMatchObject({ status: 'QUEUED', attention: [] })
  })

  it('reports null for an entry never queued', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/submissions', headers: authHeader(viewer) })
    const body = res.json<{ data: Array<{ preflight: unknown }> }>()
    expect(body.data[0]!.preflight).toBeNull()
  })
})
