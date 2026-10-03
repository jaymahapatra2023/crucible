/**
 * Scoring API contract tests (E06, P6.1–P6.5, P8.1).
 *
 * Two things under test: the envelope and status codes every endpoint owes its callers, and the
 * authorisation boundary. Scoring endpoints expose the numbers a shortlist is drawn from and the
 * evidence behind them, so who can read and who can write is part of the contract.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { computeVariance } from '../../src/modules/scoring/services/varianceService.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser
let viewer: TestUser
let provider: FakeProvider
let cohort: CohortFixture
let cohortKey: string
let runId: number

async function scoreRun(runIndex: 1 | 2, scores: number[]): Promise<number> {
  provider.setScript(scores.flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
  const outcome = await inScope(() => startRun({
    cohortKey, runIndex, submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  await computeRanking(outcome.run.run_index_id, ACTOR)
  return outcome.run.run_index_id
}

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
  cohortKey = `api-cohort-${Date.now()}`
  cohort = await seedCohort({ count: 3 })
  runId = await scoreRun(1, [4, 3, 2])
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

afterAll(async () => {
  await closeApp()
})

describe('the envelope (P6.1)', () => {
  it('wraps a run in { data }', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}`, headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { run: { run_index: number }; health: { total: number } } }
    expect(body.data.run.run_index).toBe(1)
    expect(body.data.health.total).toBeGreaterThan(0)
  })

  it('returns 404 with a code for a run that does not exist', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/scoring/runs/999999', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('rejects a malformed run id with 400, not 500', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/scoring/runs/not-a-number', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('authorisation (P8.1, P8.2)', () => {
  it('refuses every scoring endpoint without a token', async () => {
    for (const url of [
      `/api/v1/scoring/runs/${runId}`,
      `/api/v1/scoring/runs/${runId}/ranking`,
      `/api/v1/scoring/cohorts/${cohortKey}/variance`,
      '/api/v1/principles',
    ]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(401)
    }
  })

  it('lets a viewer read a run but NOT the ranking', async () => {
    const run = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}`, headers: authHeader(viewer),
    })
    const ranking = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/ranking`, headers: authHeader(viewer),
    })
    expect(run.statusCode).toBe(200)
    expect(ranking.statusCode).toBe(403)
  })

  it('refuses a reviewer starting a scoring run', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/scoring/runs', headers: authHeader(reviewer),
      payload: { cohortKey: 'x', runIndex: 2, submissionIds: cohort.submissionIds },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a reviewer adopting a principle', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/principles/1', headers: authHeader(reviewer),
      payload: { active: true },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('scores for one submission (E06-S02, E06-S04)', () => {
  it('returns criteria with their evidence', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/scoring/runs/${runId}/scores?submissionId=${cohort.submissionIds[0]}`,
      headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)

    const { data } = res.json() as {
      data: { criteria: Array<{ raw_score: number; evidence: unknown[] }> }
    }
    expect(data.criteria[0]!.raw_score).toBe(4)
    expect(data.criteria[0]!.evidence).not.toHaveLength(0)
  })

  it('includes the METRIC INPUTS behind the engineering score (E06-S04 acceptance 3)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/scoring/runs/${runId}/scores?submissionId=${cohort.submissionIds[0]}`,
      headers: authHeader(viewer),
    })
    const { data } = res.json() as {
      data: { metrics: { summary: string; filesAnalysed: number } | null }
    }
    expect(data.metrics?.summary).toMatch(/files analysed/)
    expect(data.metrics?.filesAnalysed).toBeGreaterThan(0)
  })

  it('requires the submission id rather than guessing one', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/scores`, headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('the ranking (E07-S04)', () => {
  it('returns the stored ordering and says how much of it is partial', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/ranking`, headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)

    const { data } = res.json() as {
      data: {
        ranked: Array<{ rank_global: number; submission_id: number }>
        fallbackChallenges: number[]
        partialCount: number
        stale: boolean
      }
    }
    expect(data.ranked.map((r) => r.rank_global)).toEqual([1, 2, 3])
    expect(data.stale).toBe(false)
    // Three submissions is below the cohort floor, and the response says so rather than
    // presenting a percentile nobody should trust.
    expect(data.fallbackChallenges).toContain(cohort.challengeId)
  })

  it('REFUSES to invent a ranking that was never computed', async () => {
    await query('DELETE FROM ranking_snapshot WHERE run_index_id = $1', [runId])
    await query('DELETE FROM submission_composite WHERE run_index_id = $1', [runId])

    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/ranking`, headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(412)
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/does not invent a ranking on read/)
  })

  it('refuses a reviewer computing one — that writes', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/scoring/runs/${runId}/ranking`, headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('lets an organiser recompute it', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/scoring/runs/${runId}/ranking`, headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { ranked: unknown[] } }).data.ranked).toHaveLength(3)
  })

  it('serves the cohort sizes recorded before scoring (E07-S03 acceptance 1)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/cohorts`, headers: authHeader(viewer),
    })
    const { data } = res.json() as {
      data: Array<{ cohort_size: number; below_floor: boolean; floor_used: number }>
    }
    expect(data[0]?.cohort_size).toBe(3)
    expect(data[0]?.below_floor).toBe(true)
  })

  it('serves the challenge split with its medians (E07-S05)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/split`, headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)

    const { data } = res.json() as {
      data: { byChallenge: Array<{ medianComposite: number | null }>; advisory: string | null }
    }
    expect(data.byChallenge[0]?.medianComposite).not.toBeNull()
  })

  it('exports the ranking as CSV with its caveats (E07-S03 acceptance 3)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/ranking.csv`,
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    expect(res.body).toContain('cohort_below_floor')
    expect(res.body).toContain('ABSOLUTE_FALLBACK')
  })

  it('refuses the export to a viewer — it carries team names beside positions', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/ranking.csv`,
      headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('exposes NOTHING that marks a submission as selected (P0 constraint 1)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/ranking`, headers: authHeader(reviewer),
    })
    expect(res.body).not.toMatch(/"selected"|"shortlisted"|"eliminated"/)
  })

  it('serves the cut band, with the advisory call-out separated (E07-S06)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/scoring/runs/${runId}/borderline`, headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)

    const { data } = res.json() as {
      data: { cutLine: number; band: unknown[]; advisoryDecided: unknown[]; tiedAtCut: unknown[] }
    }
    expect(data.cutLine).toBe(25)
    expect(Array.isArray(data.band)).toBe(true)
    expect(Array.isArray(data.advisoryDecided)).toBe(true)
  })
})

describe('variance (E06-S06)', () => {
  it('refuses to compute with only one run, and says why', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/scoring/cohorts/${cohortKey}/variance`,
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(412)
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/both run 1 and run 2/)
  })

  it('computes and then serves the comparison', async () => {
    await scoreRun(2, [4, 1, 2])

    const computed = await app.inject({
      method: 'POST', url: `/api/v1/scoring/cohorts/${cohortKey}/variance`,
      headers: authHeader(organiser),
    })
    expect(computed.statusCode).toBe(200)

    const listed = await app.inject({
      method: 'GET', url: `/api/v1/scoring/cohorts/${cohortKey}/variance`,
      headers: authHeader(reviewer),
    })
    const { data } = listed.json() as { data: { all: unknown[]; openCount: number } }
    expect(data.all).toHaveLength(3)
  })

  it('REFUSES a dismissal with no reason (acceptance 5)', async () => {
    await scoreRun(2, [4, 1, 2])
    await computeVariance(cohortKey)

    const res = await app.inject({
      method: 'POST', url: `/api/v1/scoring/cohorts/${cohortKey}/variance/dismiss`,
      headers: authHeader(reviewer),
      payload: { submissionId: cohort.submissionIds[1] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('REFUSES a reason too short to be one', async () => {
    await scoreRun(2, [4, 1, 2])
    await computeVariance(cohortKey)

    const res = await app.inject({
      method: 'POST', url: `/api/v1/scoring/cohorts/${cohortKey}/variance/dismiss`,
      headers: authHeader(reviewer),
      payload: { submissionId: cohort.submissionIds[1], reason: 'fine' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a dismissal with a real reason and audits it', async () => {
    await scoreRun(2, [4, 1, 2])
    await computeVariance(cohortKey)

    const res = await app.inject({
      method: 'POST', url: `/api/v1/scoring/cohorts/${cohortKey}/variance/dismiss`,
      headers: authHeader(reviewer),
      payload: {
        submissionId: cohort.submissionIds[1],
        reason: 'Both runs cite the same evidence; the difference is anchor wording.',
      },
    })
    expect(res.statusCode).toBe(200)

    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'scoring.variance_flag_dismissed'`)
    expect(audit.rows).toHaveLength(1)
  })
})

describe('principles and standards (E06-S03, OD-2)', () => {
  it('lists both, and SAYS when nothing has been adopted', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/principles', headers: authHeader(viewer),
    })
    const { data } = res.json() as {
      data: { principles: unknown[]; adoptedPrinciples: number; note: string | null }
    }
    expect(data.principles).not.toHaveLength(0)
    expect(data.adoptedPrinciples).toBe(0)
    expect(data.note).toMatch(/not scored at all/)
  })

  it('adopting one is recorded in the audit log', async () => {
    const [principle] = (await query<{ principle_id: number }>(
      'SELECT principle_id FROM arch_principle ORDER BY sort_order LIMIT 1')).rows

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/principles/${principle!.principle_id}`,
      headers: authHeader(organiser), payload: { active: true },
    })
    expect(res.statusCode).toBe(200)

    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'scoring.principle_adopted'`)
    expect(audit.rows).toHaveLength(1)
  })

  it('404s a principle that does not exist', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/principles/999999',
      headers: authHeader(organiser), payload: { active: true },
    })
    expect(res.statusCode).toBe(404)
  })
})
