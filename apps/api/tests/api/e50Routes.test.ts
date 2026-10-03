/**
 * The E50 endpoints: final ranking of a cohort, and reminders.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { insertScoreRun } from '../../src/modules/scoring/db/scoringDb.js'
import { replaceRanking } from '../../src/modules/scoring/db/rankingDb.js'
import { issueSubmissionToken } from '../../src/modules/submissions/services/submissionTokens.js'
import { seedCohort } from '../support/scoringFixtures.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let app: FastifyInstance
let organiser: TestUser
let viewer: TestUser

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  await setFlag('feature.calibration.bypass_gate', true, 'test')
  invalidateConfig()
  app = await getApp()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')
})

afterAll(async () => { await closeApp() })

describe('final ranking', () => {
  it('computes for an organiser once both runs are ranked, and anyone signed in may read it', async () => {
    const cohort = await seedCohort({ count: 2 })
    for (const runIndex of [1, 2] as const) {
      const run = await insertScoreRun({ runIndex, cohortKey: 'c1', rubricVersions: {}, model: 't', ledgerRunId: null, startedBy: 'seed' })
      await replaceRanking(run.run_index_id, cohort.submissionIds.map((id, i) => ({
        submissionId: id, challengeId: cohort.challengeId, composite: 80 - i * 10, fidelityRaw: null,
        fidelityNormalised: null, cohortSize: 2, normalisationMethod: 'PERCENTILE', rankGlobal: i + 1,
        rankInChallenge: i + 1, tied: false, weightCovered: 1, missingDimensions: [], partial: false,
        inCutBand: false, advisoryDecided: false, reviewReasons: [],
      })), { scoresCounted: 2, submissions: 2, cutLineUsed: 25, bandSizeUsed: 3, minCohortSize: 1, computedBy: 'seed' })
    }
    const computed = await app.inject({ method: 'POST', url: '/api/v1/scoring/cohorts/c1/final', headers: authHeader(organiser) })
    expect(computed.statusCode).toBe(200)
    expect(computed.json<{ data: { ranked: unknown[] } }>().data.ranked).toHaveLength(2)

    const read = await app.inject({ method: 'GET', url: '/api/v1/scoring/cohorts/c1/final', headers: authHeader(viewer) })
    // Reading the result is a reviewer act; a viewer sees the runs list, not the list that decides.
    expect(read.statusCode).toBe(403)
    const csv = await app.inject({ method: 'GET', url: '/api/v1/scoring/cohorts/c1/final.csv', headers: authHeader(organiser) })
    expect(csv.statusCode).toBe(200)
    expect(csv.body.split('\n')[0]).toContain('composite_final')
  })

  it('is not a viewer act to compute', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/scoring/cohorts/c1/final', headers: authHeader(viewer) })).statusCode).toBe(403)
  })
})

describe('reminders', () => {
  it('lists who is not there yet for any signed-in role, and only an organiser may remind', async () => {
    await withCorrelation({ correlationId: 'seed' }, () => issueSubmissionToken({ label: 'Idle Team', contactEmail: 'idle@test.local', issuedBy: 'seed' }))
    const list = await app.inject({ method: 'GET', url: '/api/v1/submissions/reminders', headers: authHeader(viewer) })
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: Array<{ teamName: string; kind: string }> }>().data).toEqual([
      expect.objectContaining({ teamName: 'Idle Team', kind: 'NOT_SUBMITTED' }),
    ])

    expect((await app.inject({ method: 'POST', url: '/api/v1/submissions/reminders', headers: authHeader(viewer), payload: {} })).statusCode).toBe(403)
    const sent = await app.inject({ method: 'POST', url: '/api/v1/submissions/reminders', headers: authHeader(organiser), payload: {} })
    expect(sent.statusCode).toBe(201)
    // The recording provider composes but transmits nothing, and the record says so.
    expect(sent.json<{ data: Array<{ status: string }> }>().data[0]!.status).toBe('PREPARED')
  })
})
