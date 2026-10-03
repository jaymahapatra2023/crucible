/**
 * Coach sheet endpoints (E51): reviewers read, organisers send and download.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { insertScoreRun } from '../../src/modules/scoring/db/scoringDb.js'
import { replaceRanking } from '../../src/modules/scoring/db/rankingDb.js'
import { seedCohort } from '../support/scoringFixtures.js'

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser
let viewer: TestUser
let runId: number
let submissionId: number

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  app = await getApp()
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
  viewer = await makeUser('viewer')
  const cohort = await seedCohort({ count: 2 })
  submissionId = cohort.submissionIds[0]!
  const run = await insertScoreRun({ runIndex: 1, cohortKey: 'cr', rubricVersions: {}, model: 't', ledgerRunId: null, startedBy: 'seed' })
  runId = run.run_index_id
  await replaceRanking(runId, cohort.submissionIds.map((id, i) => ({
    submissionId: id, challengeId: cohort.challengeId, composite: 80 - i * 10, fidelityRaw: null, fidelityNormalised: null,
    cohortSize: 2, normalisationMethod: 'PERCENTILE', rankGlobal: i + 1, rankInChallenge: i + 1, tied: false,
    weightCovered: 1, missingDimensions: [], partial: false, inCutBand: false, advisoryDecided: false, reviewReasons: [],
  })), { scoresCounted: 0, submissions: 2, cutLineUsed: 1, bandSizeUsed: 0, minCohortSize: 1, computedBy: 'seed' })
})

afterAll(async () => { await closeApp() })

describe('reading', () => {
  it('lists the sheets in scope for a reviewer, with the dispatch record', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/coach-sheets?scope=cutline`, headers: authHeader(reviewer) })
    expect(res.statusCode).toBe(200)
    const data = res.json<{ data: { scope: string; sheets: Array<{ submissionId: number }>; dispatches: unknown[] } }>().data
    expect(data.scope).toBe('cutline')
    expect(data.sheets.map((s) => s.submissionId)).toEqual([submissionId])
    expect(data.dispatches).toEqual([])
  })

  it('defaults to the shortlist scope and rejects an unknown one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/coach-sheets`, headers: authHeader(reviewer) })
    expect(res.json<{ data: { scope: string } }>().data.scope).toBe('shortlist')
    expect((await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/coach-sheets?scope=all`, headers: authHeader(reviewer) })).statusCode).toBe(400)
  })

  it('serves one team\'s sheet, and 404s a team outside the run', async () => {
    const one = await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/teams/${submissionId}/coach-sheet`, headers: authHeader(reviewer) })
    expect(one.statusCode).toBe(200)
    expect(one.json<{ data: { teamName: string } }>().data.teamName).toMatch(/^Team/)
    expect((await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/teams/424242/coach-sheet`, headers: authHeader(reviewer) })).statusCode).toBe(404)
  })

  it('is not a viewer act', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/coach-sheets`, headers: authHeader(viewer) })).statusCode).toBe(403)
  })
})

describe('sending and downloading', () => {
  it('is an organiser act: a reviewer may not send or download', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/review/runs/${runId}/coach-sheets/send?scope=cutline`, headers: authHeader(reviewer) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/coach-sheets.txt?scope=cutline`, headers: authHeader(reviewer) })).statusCode).toBe(403)
  })

  it('sends with 201, naming the teams that have no coach', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/review/runs/${runId}/coach-sheets/send?scope=cutline`, headers: authHeader(organiser) })
    expect(res.statusCode).toBe(201)
    const data = res.json<{ data: { sent: unknown[]; uncoached: string[] } }>().data
    expect(data.sent).toEqual([])
    expect(data.uncoached).toHaveLength(1)
  })

  it('refuses to send an empty scope with a reason, not a silent success', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/review/runs/${runId}/coach-sheets/send`, headers: authHeader(organiser) })
    expect(res.statusCode).toBe(412)
    expect(res.body).toContain('Nothing is shortlisted yet')
  })

  it('downloads the organiser copy as text with the standing', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/review/runs/${runId}/coach-sheets.txt?scope=cutline`, headers: authHeader(organiser) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.headers['content-disposition']).toContain(`coach-sheets-run-${runId}.txt`)
    expect(res.body).toContain('Standing: rank 1 in run')
  })
})
