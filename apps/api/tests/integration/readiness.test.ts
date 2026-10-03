/**
 * The system-level definition of done (plan §IV.5).
 *
 * Seven statements the plan says must be true before this system decides anything. They were
 * written as a checklist for a person, and a checklist a person keeps on the night, under time
 * pressure, is a checklist that is partly kept — so these tests are about the report catching
 * each individual gap rather than reporting a cheerful aggregate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { readinessReport } from '../../src/modules/platform/services/readinessReport.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { decide, openShortlist } from '../../src/modules/review/services/shortlistService.js'
import { publishRubric } from '../../src/modules/rubrics/services/rubricExport.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
const COHORT = 'dod-cohort'

const statusOf = async (id: string) =>
  (await readinessReport(COHORT)).checks.find((c) => c.id === id)

/** Score the cohort once, under `runIndex`. */
async function scoreOnce(runIndex: 1 | 2): Promise<number> {
  provider.setResponder((req) =>
    JSON.stringify(req).includes('ADVISORY') ? originalityTurn(3) : scoreTurn(3))
  const outcome = await inScope(() => startRun({
    cohortKey: COHORT, runIndex, submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  return outcome.run.run_index_id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  cohort = await seedCohort({ count: 3 })
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

/** The seven §IV.5 statements. Later additions are welcome; losing one of these is not. */
const PLAN_CHECKS = [
  'rubric_frozen', 'submission_evidence', 'two_runs', 'ranking',
  'calibration', 'cut_band', 'appeal_packet',
] as const

describe('an empty cohort', () => {
  it('reports UNKNOWN rather than passing checks it could not make', async () => {
    const report = await readinessReport('nothing-here')
    // A check that could not be evaluated is not a check that passed.
    expect(report.ready).toBe(false)
    expect(report.checks.some((c) => c.status === 'UNKNOWN')).toBe(true)
  })

  it('carries the plan\'s wording, so the report is self-explaining', async () => {
    const report = await readinessReport('nothing-here')
    // Asserted by CONTENT, not by count. A hard-coded total breaks every time a check is
    // added — which it has, twice — and says nothing about whether the right ones are there.
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(PLAN_CHECKS))
    expect(report.checks[0]?.statement).toMatch(/frozen, published rubric/)
  })
})

describe('the individual statements', () => {
  beforeEach(async () => {
    await scoreOnce(1)
  })

  it('FAILS the rubric check when the frozen rubric was never published', async () => {
    const check = await statusOf('rubric_frozen')
    expect(check?.status).toBe('FAIL')
    expect(check?.detail).toMatch(/none has a publication record/)
  })

  it('PASSES the rubric check once it is published', async () => {
    await inScope(() => publishRubric(cohort.rubricId, ACTOR))
    const check = await statusOf('rubric_frozen')
    expect(check?.status).toBe('PASS')
  })

  it('FAILS the evidence check and NAMES what is missing', async () => {
    const check = await statusOf('submission_evidence')
    expect(check?.status).toBe('FAIL')
    // Nothing was probed in this fixture, and the report says so rather than "incomplete".
    expect(check?.detail).toMatch(/3 never probed/)
  })

  it('FAILS the two-runs check when only one run exists', async () => {
    const check = await statusOf('two_runs')
    expect(check?.status).toBe('FAIL')
    expect(check?.detail).toMatch(/1 of 2 score runs/)
  })

  it('PASSES the two-runs check once both exist, and confirms evidence was cited', async () => {
    await scoreOnce(2)
    const check = await statusOf('two_runs')
    expect(check?.status).toBe('PASS')
    expect(check?.detail).toMatch(/file-and-line evidence/)
  })

  it('FAILS the ranking check before a ranking is computed', async () => {
    expect((await statusOf('ranking'))?.status).toBe('FAIL')
  })

  it('PASSES the ranking check and SURFACES the cohort fallback as a caveat', async () => {
    const runs = await query<{ run_index_id: number }>(
      'SELECT run_index_id FROM score_run WHERE cohort_key = $1', [COHORT])
    await computeRanking(runs.rows[0]!.run_index_id, ACTOR)

    const check = await statusOf('ranking')
    expect(check?.status).toBe('PASS')
    // Three submissions is below the normalisation floor; that is a caveat, not a failure.
    expect(check?.detail).toMatch(/absolute fidelity/)
  })

  it('FAILS the calibration check when no gate decision exists', async () => {
    const check = await statusOf('calibration')
    expect(check?.status).toBe('FAIL')
    expect(check?.detail).toMatch(/uncalibrated system must not rank/)
  })

  it('PASSES the calibration check on a recorded NO_GO — the fallback counts', async () => {
    await seedGate('NO_GO')
    const check = await statusOf('calibration')
    // The statement is "passed its gate OR the fallback was invoked and recorded".
    expect(check?.status).toBe('PASS')
    expect(check?.detail).toMatch(/FAILED by .* and the fallback recorded/)
  })
})

describe('the cut band (§IV.5.6)', () => {
  let runIndexId: number

  beforeEach(async () => {
    await inScope(() => setConfig('scoring.cut_line', 1, ACTOR))
    await inScope(() => setConfig('scoring.cut_band_size', 0, ACTOR))
    invalidateConfig()

    runIndexId = await scoreOnce(1)
    await computeRanking(runIndexId, ACTOR)
    await openShortlist(runIndexId, ACTOR)
  })

  it('FAILS while a band submission has no decision', async () => {
    const check = await statusOf('cut_band')
    expect(check?.status).toBe('FAIL')
    expect(check?.detail).toMatch(/have no recorded decision/)
  })

  it('STILL FAILS when decided but a caveat is unanswered', async () => {
    const band = await query<{ submission_id: number }>(
      'SELECT submission_id FROM submission_composite WHERE run_index_id = $1 AND in_cut_band',
      [runIndexId])
    for (const row of band.rows) {
      await decide({
        runIndexId, submissionId: row.submission_id, decision: 'SHORTLIST',
        reason: 'Reviewed the evidence and accept this placement.', actor: ACTOR,
      })
    }

    const check = await statusOf('cut_band')
    expect(check?.status).toBe('FAIL')
    expect(check?.detail).toMatch(/unanswered caveat/)
  })

  it('PASSES once every band entry is decided and its caveats answered', async () => {
    const band = await query<{ submission_id: number }>(
      'SELECT submission_id FROM submission_composite WHERE run_index_id = $1 AND in_cut_band',
      [runIndexId])
    for (const row of band.rows) {
      await decide({
        runIndexId, submissionId: row.submission_id, decision: 'SHORTLIST',
        reason: 'Reviewed the evidence and accept this placement.', actor: ACTOR,
      })
    }
    await query(
      `UPDATE review_flag rf SET dismissed_at = now(), dismissed_by = $2,
              dismissal_reason = 'Reviewed and accepted by the committee.'
         FROM submission_composite sc
        WHERE sc.run_index_id = rf.run_index_id AND sc.submission_id = rf.submission_id
          AND rf.run_index_id = $1 AND sc.in_cut_band`,
      [runIndexId, ACTOR])

    expect((await statusOf('cut_band'))?.status).toBe('PASS')
  })
})

describe('overall readiness', () => {
  it('is NOT ready while any statement fails', async () => {
    await scoreOnce(1)
    expect((await readinessReport(COHORT)).ready).toBe(false)
  })

  it('reports every statement, not only the failing ones', async () => {
    await scoreOnce(1)
    const report = await readinessReport(COHORT)
    // An operator needs to see what is done as well as what is not.
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(PLAN_CHECKS))
    expect(report.checks.every((c) => c.detail.length > 10)).toBe(true)
  })
})

async function seedGate(decision: 'GO' | 'NO_GO'): Promise<void> {
  const set = await query<{ golden_set_id: number }>(
    `INSERT INTO golden_set (name, status, sealed_at, sealed_by, created_by)
     VALUES ('G', 'SEALED', now(), 'x', 'x') RETURNING golden_set_id`)
  const criteria = await query<{ criteria_id: number }>(
    `INSERT INTO gate_criteria
       (golden_set_id, min_rank_correlation, max_material_disagreements, material_rank_gap,
        max_run_variance, fallback_plan, recorded_by)
     VALUES ($1, 0.7, 1, 3, 10, 'Fall back to fully human judging entirely.', 'x')
     RETURNING criteria_id`, [set.rows[0]!.golden_set_id])
  const report = await query<{ report_id: number }>(
    `INSERT INTO calibration_report
       (golden_set_id, criteria_id, run_index_id, rank_correlation, sample_size,
        material_disagreements, generated_by)
     VALUES ($1, $2, 1, 0.4, 8, 3, 'x') RETURNING report_id`,
    [set.rows[0]!.golden_set_id, criteria.rows[0]!.criteria_id])
  await query(
    `INSERT INTO gate_decision (report_id, decision, rationale, decided_by)
     VALUES ($1, $2, 'Recorded for the purposes of this test scenario.', 'chair@test.local')`,
    [report.rows[0]!.report_id, decision])
}
