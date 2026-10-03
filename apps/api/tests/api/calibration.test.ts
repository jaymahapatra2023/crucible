/**
 * Calibration API contract (E11, P6.x, P8.1).
 *
 * The authorisation split carries the epic's meaning: hand-ranking is a judging act open to
 * reviewers, while the golden set, the criteria and the go/no-go decision are the record that
 * this system was shown fit to eliminate teams — organiser and above.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { query } from '../../src/db/pool.js'

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser
let viewer: TestUser
let setId: number

const FALLBACK = 'Fall back to fully human judging; the system gathers evidence only.'

const criteriaPayload = {
  minRankCorrelation: 0.7, maxMaterialDisagreements: 1, materialRankGap: 3,
  maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '',
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  app = await getApp()
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
  viewer = await makeUser('viewer')

  const created = await app.inject({
    method: 'POST', url: '/api/v1/calibration/sets', headers: authHeader(organiser),
    payload: { name: 'Golden 2026', description: 'For the go/no-go gate.' },
  })
  setId = (created.json() as { data: { golden_set_id: number } }).data.golden_set_id
})

afterAll(async () => {
  await closeApp()
})

describe('authorisation (E09-S03, P8.1)', () => {
  it('refuses every calibration endpoint without a token', async () => {
    for (const url of [
      '/api/v1/calibration/sets',
      `/api/v1/calibration/sets/${setId}`,
      '/api/v1/calibration/gate',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401)
    }
  })

  it('refuses a reviewer creating a golden set', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/calibration/sets', headers: authHeader(reviewer),
      payload: { name: 'Mine' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('LETS a reviewer hand-rank — that is a judging act', async () => {
    const entry = await addEntry()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/calibration/sets/${setId}/rankings`,
      headers: authHeader(reviewer),
      payload: { ranker: 'alice', positions: [{ entryId: entry, position: 1 }] },
    })
    // Past the role check; it may still be refused for being a partial ranking.
    expect(res.statusCode).not.toBe(403)
  })

  it('refuses a reviewer recording gate criteria', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/calibration/sets/${setId}/criteria`,
      headers: authHeader(reviewer), payload: criteriaPayload,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a reviewer taking the go/no-go decision', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/calibration/reports/1/decision',
      headers: authHeader(reviewer),
      payload: { decision: 'GO', rationale: 'Everything looks fine to me on the numbers.' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('the golden set', () => {
  it('reports readiness with the reasons it cannot be sealed', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/calibration/sets/${setId}`, headers: authHeader(viewer),
    })
    const { data } = res.json() as {
      data: { readiness: { canSeal: boolean; problems: string[] } }
    }

    expect(data.readiness.canSeal).toBe(false)
    expect(data.readiness.problems.join(' ')).toMatch(/0 of 8 repositories/)
    expect(data.readiness.problems.join(' ')).toMatch(/Missing edge case/)
  })

  it('rejects an entry with an unknown band', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/calibration/sets/${setId}/entries`,
      headers: authHeader(organiser),
      payload: {
        label: 'x', repoUrl: 'https://github.com/g/x', expectedBand: 'EXCELLENT',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a repository URL that is not a URL', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/calibration/sets/${setId}/entries`,
      headers: authHeader(organiser),
      payload: { label: 'x', repoUrl: 'not-a-url', expectedBand: 'STRONG' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('REFUSES to seal a set that is not ready, and says why', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/calibration/sets/${setId}/seal`,
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(412)
    expect(res.body).toMatch(/not ready to seal/)
  })
})

describe('linking entries to submissions (E21)', () => {
  const entry = (label: string, repoUrl: string) => app.inject({
    method: 'POST', url: `/api/v1/calibration/sets/${setId}/entries`,
    headers: authHeader(organiser),
    payload: { label, repoUrl, expectedBand: 'MIDDLING', edgeCase: null, notes: '' },
  })

  const link = (confirm: boolean, user = organiser) => app.inject({
    method: 'POST', url: `/api/v1/calibration/sets/${setId}/link`,
    headers: authHeader(user), payload: { confirm },
  })

  it('reports an entry with no submission rather than linking nothing silently', async () => {
    await entry('lonely', 'https://github.com/golden/never-submitted')

    const res = await link(false)
    expect(res.statusCode).toBe(200)
    const data = (res.json() as {
      data: { rows: Array<{ outcome: string }>; summary: { unresolved: number } }
    }).data
    expect(data.rows[0]!.outcome).toBe('NO_SUBMISSION')
    expect(data.summary.unresolved).toBe(1)
  })

  it('REFUSES a confirmed link while anything is unresolved', async () => {
    await entry('lonely', 'https://github.com/golden/never-submitted')

    const data = (await link(true)).json() as { data: { linked: boolean; refusal: string } }
    expect(data.data.linked).toBe(false)
    expect(data.data.refusal).toMatch(/Nothing was linked/)
  })

  it('refuses a set with no entries, saying so', async () => {
    const res = await link(false)
    expect(res.statusCode).toBe(412)
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/no entries to link/)
  })

  it('is organiser-only — it decides what the gate is measured against', async () => {
    expect((await link(false, reviewer)).statusCode).toBe(403)
    expect((await link(false, viewer)).statusCode).toBe(403)
  })
})

describe('gate criteria and the decision', () => {
  it('rejects a fallback plan too short to be a plan', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/calibration/sets/${setId}/criteria`,
      headers: authHeader(organiser),
      payload: { ...criteriaPayload, fallbackPlan: 'human' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('records criteria and serves them back', async () => {
    const created = await app.inject({
      method: 'POST', url: `/api/v1/calibration/sets/${setId}/criteria`,
      headers: authHeader(organiser), payload: criteriaPayload,
    })
    expect(created.statusCode).toBe(200)

    const read = await app.inject({
      method: 'GET', url: `/api/v1/calibration/sets/${setId}/criteria`,
      headers: authHeader(viewer),
    })
    const { data } = read.json() as { data: { current: { fallback_plan: string } } }
    expect(data.current.fallback_plan).toBe(FALLBACK)
  })

  it('rejects a decision rationale too short to be one', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/calibration/reports/1/decision',
      headers: authHeader(organiser), payload: { decision: 'GO', rationale: 'fine' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a decision outside GO and NO_GO', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/calibration/reports/1/decision',
      headers: authHeader(organiser),
      payload: { decision: 'MAYBE', rationale: 'We are not sure about this at all yet.' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('the gate status', () => {
  it('says plainly that no decision means ranking is refused', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/calibration/gate', headers: authHeader(viewer),
    })
    const { data } = res.json() as {
      data: { status: null; rankingPermitted: boolean; note: string }
    }

    expect(data.status).toBeNull()
    expect(data.rankingPermitted).toBe(false)
    // The state most easily mistaken for a pass, spelled out.
    expect(data.note).toMatch(/must not be usable by default/)
  })

  it('reports a recorded NO_GO with who decided it', async () => {
    await seedDecision('NO_GO')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/calibration/gate', headers: authHeader(viewer),
    })
    const { data } = res.json() as {
      data: { status: { decision: string; decided_by: string }; rankingPermitted: boolean }
    }

    expect(data.status.decision).toBe('NO_GO')
    expect(data.status.decided_by).toBe('chair@test.local')
    expect(data.rankingPermitted).toBe(false)
  })

  it('reports a GO as permitting ranking', async () => {
    await seedDecision('GO')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/calibration/gate', headers: authHeader(viewer),
    })
    expect((res.json() as { data: { rankingPermitted: boolean } }).data.rankingPermitted)
      .toBe(true)
  })
})

async function addEntry(): Promise<number> {
  const res = await app.inject({
    method: 'POST', url: `/api/v1/calibration/sets/${setId}/entries`,
    headers: authHeader(organiser),
    payload: {
      label: `e-${Math.random().toString(36).slice(2, 7)}`,
      repoUrl: 'https://github.com/g/x', expectedBand: 'STRONG',
    },
  })
  return (res.json() as { data: { entry_id: number } }).data.entry_id
}

async function seedDecision(decision: string): Promise<void> {
  const criteria = await query<{ criteria_id: number }>(
    `INSERT INTO gate_criteria
       (golden_set_id, min_rank_correlation, max_material_disagreements, material_rank_gap,
        max_run_variance, fallback_plan, recorded_by)
     VALUES ($1, 0.7, 1, 3, 10, $2, 'test') RETURNING criteria_id`,
    [setId, FALLBACK])

  const report = await query<{ report_id: number }>(
    `INSERT INTO calibration_report
       (golden_set_id, criteria_id, run_index_id, rank_correlation, sample_size,
        material_disagreements, generated_by)
     VALUES ($1, $2, 1, 0.5, 8, 3, 'test') RETURNING report_id`,
    [setId, criteria.rows[0]!.criteria_id])

  await query(
    `INSERT INTO gate_decision (report_id, decision, rationale, decided_by)
     VALUES ($1, $2, 'Recorded for the purposes of this contract test.', 'chair@test.local')`,
    [report.rows[0]!.report_id, decision])
}
