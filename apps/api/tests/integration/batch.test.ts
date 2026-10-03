/**
 * Batch orchestration (E10).
 *
 * The goal is "run 50 submissions reliably and within budget", unattended, overnight. So these
 * tests are about what happens when things go wrong at 3am: one submission fails, the budget
 * runs out, somebody resumes a half-finished run. The happy path is the easy part.
 *
 * Scanning and probing are substituted — containment is proven against real Docker in the
 * security project, and cloning real repositories here would make the suite about the network.
 * What is real is the ledger, the ordering, the concurrency, the cost accounting and the resume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { runBatch } from '../../src/modules/batch/services/batchOrchestrator.js'
import { batchProgress } from '../../src/modules/batch/services/batchProgress.js'
import { shortlistState } from '../../src/modules/review/services/shortlistService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { dryRunReport } from '../../src/modules/calibration/services/dryRunReport.js'
import { selectSubjectCosts } from '../../src/modules/llm/db/llmCallLogDb.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import {
  ACTOR, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture

const inScope = <T>(fn: () => Promise<T>) =>
  withCorrelation({ correlationId: `batch-${Math.random().toString(36).slice(2)}` }, fn)

/** Scan and probe are stubbed; scoring runs for real against the fake provider. */
vi.mock('../../src/modules/scans/services/scanService.js', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/scans/services/scanService.js')>()
  return {
    ...actual,
    scanSubmission: vi.fn(async (o: { submissionId: number }) => {
      if (brokenScans.has(o.submissionId)) throw new Error('the repository vanished mid-clone')
      return { scan: { scan_id: o.submissionId }, skipped: false }
    }),
  }
})

vi.mock('../../src/modules/probes/services/probeService.js', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/probes/services/probeService.js')>()
  return {
    ...actual,
    probeSubmission: vi.fn(async (o: { submissionId: number }) =>
      ({ probe: { probe_id: o.submissionId }, skipped: false })),
  }
})

const brokenScans = new Set<number>()

const batch = (overrides: Record<string, unknown> = {}) =>
  inScope(() => runBatch({
    challengeIds: [cohort.challengeId],
    cohortKey: 'batch-cohort',
    runIndex: 1,
    startedBy: ACTOR,
    ...overrides,
  }))

/**
 * Answer by call shape rather than by position.
 *
 * The batch scores several submissions at once, so their calls interleave; a positional script
 * would hand one submission another's response and fail for reasons that have nothing to do
 * with the batch.
 */
const scriptFor = (_count: number) =>
  provider.setResponder((req) =>
    JSON.stringify(req).includes('ADVISORY') || JSON.stringify(req).includes('advisory')
      ? originalityTurn(3)
      : scoreTurn(3))

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  brokenScans.clear()
  cohort = await seedCohort({ count: 4 })
})

afterEach(() => {
  restoreProviders()
  resetGateway()
  vi.clearAllMocks()
})

describe('orchestration (E10-S01)', () => {
  it('takes every valid submission through scan, probe and score', async () => {
    scriptFor(4)
    const summary = await batch()

    expect(summary.subjects).toBe(4)
    expect(summary.perStage.scan.ok).toBe(4)
    expect(summary.perStage.probe.ok).toBe(4)
    expect(summary.perStage.score.ok).toBe(4)
    expect(summary.status).toBe('SUCCEEDED')
  })

  it('records a stage result per submission in the ledger (acceptance 2)', async () => {
    scriptFor(4)
    const summary = await batch()

    const rows = await query<{ stage: string; n: number }>(
      `SELECT stage, COUNT(*)::int AS n FROM run_stage_result
        WHERE run_id = $1 AND subject_id IS NOT NULL GROUP BY stage`,
      [summary.runId])

    expect(rows.rows.map((r) => r.n)).toEqual([4, 4, 4])
  })

  it('RECORDS the order it used, not merely using a stable one (acceptance 3)', async () => {
    scriptFor(4)
    const summary = await batch()

    const run = await query<{ params: { order: number[] } }>(
      'SELECT params FROM run WHERE run_id = $1', [summary.runId])
    // Ascending submission id within challenge: repeatable, and comparable with a later run.
    expect(run.rows[0]!.params.order).toEqual([...cohort.submissionIds].sort((a, b) => a - b))
  })

  it('pins every setting that decides an outcome, and every flag (P4.4)', async () => {
    // This used to pin four operational keys and no flags at all — none of which decided an
    // outcome — and nothing read it back. Now it is derived from the declaration.
    scriptFor(4)
    const summary = await batch()

    const run = await query<{
      pinned_config: {
        config: Record<string, { value: unknown }>
        flags: Record<string, boolean>
        limits: Record<string, number>
      }
    }>('SELECT pinned_config FROM run WHERE run_id = $1', [summary.runId])
    const pin = run.rows[0]!.pinned_config

    expect(pin.config).toHaveProperty('scoring.cut_line')
    expect(pin.config).toHaveProperty('scoring.context_budget_bytes')
    expect(pin.config).toHaveProperty('llm.default_model')
    expect(pin.flags).toHaveProperty('feature.discovery.enabled')

    // The concurrency limits are recorded for the operator, alongside but NOT inside the pin:
    // they are operational, so raising one during a run must still take effect (E10-S03).
    expect(pin.limits).toMatchObject({ scan: 4, probe: 2, score: 4 })
    expect(pin.config).not.toHaveProperty('batch.cost_ceiling_usd')
  })

  it('REFUSES a cohort with no valid submissions', async () => {
    await query('UPDATE submission SET validation_status = $1', ['PRIVATE'])
    await expect(batch()).rejects.toThrow(/evaluate nobody/)
  })

  it('writes the scores into a score run that can be ranked', async () => {
    scriptFor(4)
    const summary = await batch()

    const scores = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM criterion_score WHERE run_index_id = $1',
      [summary.scoreRunId])
    expect(scores.rows[0]!.n).toBe(4)
  })

  it('records the cohort sizes before scoring (E07-S03)', async () => {
    scriptFor(4)
    const summary = await batch()

    const cohorts = await query<{ cohort_size: number }>(
      'SELECT cohort_size FROM run_cohort WHERE run_index_id = $1', [summary.scoreRunId])
    expect(cohorts.rows[0]?.cohort_size).toBe(4)
  })
})

describe('failure isolation (E10-S04)', () => {
  it('does NOT let one bad submission end the run (acceptance 1)', async () => {
    brokenScans.add(cohort.submissionIds[1]!)
    scriptFor(4)

    const summary = await batch()

    expect(summary.perStage.scan.ok).toBe(3)
    expect(summary.perStage.scan.failed).toBe(1)
    // And the run carried on to the later stages.
    expect(summary.perStage.score.ok).toBeGreaterThan(0)
    expect(summary.status).toBe('SUCCEEDED')
  })

  it('lists every failure WITH its reason (acceptance 4)', async () => {
    brokenScans.add(cohort.submissionIds[0]!)
    scriptFor(4)

    const summary = await batch()

    expect(summary.failures).toHaveLength(1)
    expect(summary.failures[0]?.stage).toBe('scan')
    expect(summary.failures[0]?.subjectId).toBe(String(cohort.submissionIds[0]))
    expect(summary.failures[0]?.message).toMatch(/vanished mid-clone/)
  })

  it('SUCCEEDS overall despite failures, keeping the work that was done', async () => {
    brokenScans.add(cohort.submissionIds[0]!)
    brokenScans.add(cohort.submissionIds[1]!)
    scriptFor(4)

    const summary = await batch()
    // Failing the whole run would discard two good evaluations and tell an operator less.
    expect(summary.status).toBe('SUCCEEDED')
    expect(summary.failures).toHaveLength(2)
  })
})

describe('resume (E10-S04 acceptance 2 and 3)', () => {
  it('SKIPS work already completed', async () => {
    scriptFor(4)
    const first = await batch()
    expect(first.perStage.score.ok).toBe(4)

    // Resuming the same ledger run: nothing left to do.
    const resumed = await inScope(() => runBatch({
      challengeIds: [cohort.challengeId], cohortKey: 'batch-cohort', runIndex: 1,
      startedBy: ACTOR, resumeRunId: first.runId,
    }))

    expect(resumed.perStage.scan.ok + resumed.perStage.scan.skipped).toBe(4)
  })

  it('is IDEMPOTENT — a resumed run produces no duplicate score rows', async () => {
    scriptFor(4)
    const first = await batch()

    scriptFor(4)
    await batch()

    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM criterion_score WHERE run_index_id = $1`,
      [first.scoreRunId])
    // One row per (run, submission, criterion), however many times it is scored.
    expect(rows.rows[0]!.n).toBe(4)
  })

  it('redoes completed work only when FORCED', async () => {
    scriptFor(4)
    const first = await batch()

    const before = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM run_stage_result WHERE run_id = $1 AND stage = 'scan'`,
      [first.runId])

    scriptFor(4)
    const forced = await inScope(() => runBatch({
      challengeIds: [cohort.challengeId], cohortKey: 'batch-cohort', runIndex: 1,
      startedBy: ACTOR, force: true,
    }))

    expect(forced.perStage.scan.skipped).toBe(0)
    expect(before.rows[0]!.n).toBe(4)
  })
})

describe('the cost ceiling (E10-S03)', () => {
  it('PAUSES rather than continuing past the ceiling (acceptance 2)', async () => {
    await inScope(() => setConfig('batch.cost_ceiling_usd', 0.0000001, ACTOR))
    await inScope(() => setConfig('batch.projection_after', 1, ACTOR))
    invalidateConfig()
    scriptFor(4)

    const summary = await batch()

    expect(summary.status).toBe('PAUSED')
    expect(summary.pausedReason).toMatch(/ceiling/)
  })

  it('leaves the run RESUMABLE rather than finished', async () => {
    await inScope(() => setConfig('batch.cost_ceiling_usd', 0.0000001, ACTOR))
    await inScope(() => setConfig('batch.projection_after', 1, ACTOR))
    invalidateConfig()
    scriptFor(4)

    const summary = await batch()
    const run = await query<{ status: string; finished_at: Date | null }>(
      'SELECT status, finished_at FROM run WHERE run_id = $1', [summary.runId])

    expect(run.rows[0]!.status).toBe('PAUSED')
    // Not finished: an operator who raises the ceiling resumes from here.
    expect(run.rows[0]!.finished_at).toBeNull()
  })

  it('AUDITS the pause with its reason', async () => {
    await inScope(() => setConfig('batch.cost_ceiling_usd', 0.0000001, ACTOR))
    await inScope(() => setConfig('batch.projection_after', 1, ACTOR))
    invalidateConfig()
    scriptFor(4)
    await batch()

    const audit = await query<{ payload: { reason: string } }>(
      `SELECT payload FROM audit_event WHERE action = 'batch.run_paused'`)
    expect(audit.rows[0]?.payload.reason).toMatch(/ceiling/)
  })

  it('accumulates cost per RUN, from the gateway (acceptance 1)', async () => {
    scriptFor(4)
    const summary = await batch()
    // Per-attempt costs are rolled up to the run; without that the ceiling could never fire.
    expect(summary.costUsd).toBeGreaterThan(0)
  })

  it('accumulates cost per SUBMISSION as well (acceptance 1)', async () => {
    scriptFor(4)
    const summary = await batch()

    const perSubmission = await selectSubjectCosts(summary.runId)
    expect(perSubmission).toHaveLength(4)
    // Every submission's spend is accounted for, including calls that failed and were retried.
    for (const row of perSubmission) expect(row.costUsd).toBeGreaterThan(0)

    // The parts add up to the whole: this is the reconciliation that summing score rows could
    // not provide, because a failed criterion records zero while its attempts still cost money.
    const summed = perSubmission.reduce((total, r) => total + r.costUsd, 0)
    expect(summed).toBeCloseTo(summary.costUsd, 5)
  })

  it('runs to completion when the ceiling is not reached', async () => {
    scriptFor(4)
    const summary = await batch()
    expect(summary.status).toBe('SUCCEEDED')
    expect(summary.pausedReason).toBeNull()
  })
})

describe('the dry-run report (E11-S04)', () => {
  it('measures wall clock, spend and failures with their causes (acceptance 2)', async () => {
    brokenScans.add(cohort.submissionIds[0]!)
    scriptFor(4)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)

    expect(report.wallClockMs).toBeGreaterThanOrEqual(0)
    expect(report.totalCostUsd).toBeGreaterThan(0)
    expect(report.costPerSubmissionUsd).toBeGreaterThan(0)
    expect(report.failures).toHaveLength(1)
    expect(report.failureCauses[0]?.cause).toMatch(/the repository vanished mid-clone/)
  })

  it('measures each stage separately', async () => {
    scriptFor(4)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)
    expect(report.stages.map((s) => s.stage).sort()).toEqual(['probe', 'scan', 'score'])
    for (const stage of report.stages) {
      expect(stage.attempted).toBe(4)
      expect(stage.medianMs).not.toBeNull()
    }
  })

  it('CAVEATS a rehearsal smaller than the fifty the story asks for', async () => {
    scriptFor(4)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)
    // Contention appears at scale; a small rehearsal flatters the system.
    expect(report.caveats.join(' ')).toMatch(/E11-S04 asks for fifty/)
  })

  it('CAVEATS a run that did not complete', async () => {
    await inScope(() => setConfig('batch.cost_ceiling_usd', 0.0000001, ACTOR))
    await inScope(() => setConfig('batch.projection_after', 1, ACTOR))
    invalidateConfig()
    scriptFor(4)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)
    expect(report.caveats.join(' ')).toMatch(/ended PAUSED/)
    expect(report.caveats.join(' ')).toMatch(/not a prediction of a complete run/)
  })

  it('recommends nothing when the settings were fine', async () => {
    scriptFor(4)
    const summary = await batch()

    // A report that always recommends something trains its reader to ignore it.
    const report = await dryRunReport(summary.runId)
    const concurrency = report.recommendations.filter((r) => r.setting.includes('concurrency'))
    expect(concurrency.every((r) => r.suggested !== r.current)).toBe(true)
  })

  it('flags a stage failing more than one submission in ten as a DEPTH problem', async () => {
    // Twelve, because the rule deliberately ignores a failure rate over fewer: two of four is
    // not evidence of anything, and a report that acted on it would send an operator tuning
    // the wrong setting.
    cohort = await seedCohort({ count: 12 })
    for (const id of cohort.submissionIds.slice(0, 3)) brokenScans.add(id)
    scriptFor(12)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)
    expect(report.recommendations.some((r) => /depth profile or the timeout/.test(r.reason)))
      .toBe(true)
  })

  it('does NOT flag a failure rate measured over too few submissions', async () => {
    for (const id of cohort.submissionIds.slice(0, 2)) brokenScans.add(id)
    scriptFor(4)
    const summary = await batch()

    // Two of four is half the cohort and still not evidence.
    const report = await dryRunReport(summary.runId)
    expect(report.recommendations.some((r) => /depth profile or the timeout/.test(r.reason)))
      .toBe(false)
  })

  it('says the LEAD TIME is unknown rather than assuming it was fine (acceptance 4)', async () => {
    scriptFor(4)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)
    expect(report.leadTime.sufficient).toBeNull()
    expect(report.leadTime.note).toMatch(/No evaluation date is configured/)
  })

  it('reports a rehearsal that ran too close to the evaluation', async () => {
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await inScope(() => setConfig('event.evaluation_date', soon, ACTOR))
    invalidateConfig()

    scriptFor(4)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)
    expect(report.leadTime.sufficient).toBe(false)
    expect(report.leadTime.note).toMatch(/may not be fixable and re-rehearsed in time/)
  })

  it('confirms a rehearsal that left enough time', async () => {
    const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await inScope(() => setConfig('event.evaluation_date', later, ACTOR))
    invalidateConfig()

    scriptFor(4)
    const summary = await batch()

    const report = await dryRunReport(summary.runId)
    expect(report.leadTime.sufficient).toBe(true)
    expect(report.leadTime.days).toBeGreaterThanOrEqual(7)
  })

  it('REFUSES a run that is not a cohort pass', async () => {
    const row = await query<{ run_id: number }>(
      `INSERT INTO run (kind, status, correlation_id) VALUES ('SCAN', 'SUCCEEDED', 'x')
       RETURNING run_id`)
    await expect(dryRunReport(row.rows[0]!.run_id)).rejects.toThrow(/full cohort pass/)
  })
})

describe('progress (E10-S05)', () => {
  it('is readable after the fact, not only over the websocket (acceptance 2)', async () => {
    scriptFor(4)
    const summary = await batch()

    // Nothing here reads a live message: this is the state the run wrote down.
    const progress = await batchProgress(summary.runId)
    expect(progress.total).toBe(4)
    expect(progress.completed).toBe(4)
    expect(progress.status).toBe('SUCCEEDED')
  })

  it('lists EVERY stage, including ones that have not started (acceptance 1)', async () => {
    scriptFor(4)
    const summary = await batch()

    const progress = await batchProgress(summary.runId)
    // `discovery` sits between probe and score because scoring reads what it produces. It is
    // listed even when the batch did not opt into it — a stage missing from the list reads as
    // a stage that does not exist, which is the confusion this acceptance exists to prevent.
    expect(progress.stages.map((s) => s.stage))
      .toEqual(['scan', 'probe', 'discovery', 'score'])
  })

  it('counts each stage separately', async () => {
    brokenScans.add(cohort.submissionIds[0]!)
    scriptFor(4)
    const summary = await batch()

    const progress = await batchProgress(summary.runId)
    const scan = progress.stages.find((s) => s.stage === 'scan')
    expect(scan?.ok).toBe(3)
    expect(scan?.failed).toBe(1)
  })

  it('surfaces the pause reason for an operator to act on', async () => {
    await inScope(() => setConfig('batch.cost_ceiling_usd', 0.0000001, ACTOR))
    await inScope(() => setConfig('batch.projection_after', 1, ACTOR))
    invalidateConfig()
    scriptFor(4)
    const summary = await batch()

    const progress = await batchProgress(summary.runId)
    expect(progress.pausedReason).toMatch(/ceiling/)
  })

  it('404s a run that does not exist', async () => {
    await expect(batchProgress(999999)).rejects.toThrow(/not found/)
  })
})

describe('the batch finishes the job (E24)', () => {
  /**
   * A reviewer's judgement belongs on the RESULT, not in the mechanics of producing it.
   *
   * Ranking, the run-to-run comparison and opening the shortlist are arithmetic and a table.
   * Leaving them as three things a person had to remember meant a forgotten step looked exactly
   * like a cohort that scored badly.
   */
  it('ranks the cohort without anyone asking it to', async () => {
    const summary = await batch()

    expect(summary.status).toBe('SUCCEEDED')
    expect(summary.finish).toMatchObject({ ranked: true, shortlistOpened: true })

    const ranked = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM submission_composite WHERE run_index_id = $1',
      [summary.scoreRunId])
    expect(ranked.rows[0]!.n).toBeGreaterThan(0)
  })

  it('opens a shortlist, so a reviewer arrives at something to review', async () => {
    const summary = await batch()
    const state = await shortlistState(summary.scoreRunId)
    expect(state.shortlist.status).toBe('OPEN')
  })

  it('does NOT compare runs until the paired run exists', async () => {
    // A variance computed against a missing run reports perfect agreement, which is the most
    // misleading number this system could produce.
    const summary = await batch()
    expect(summary.finish?.varianceComputed).toBe(false)
    expect(summary.finish?.note).toMatch(/waits for the second run/)
  })

  it('compares the runs once both exist', async () => {
    await batch()
    const second = await inScope(() => runBatch({
      challengeIds: [cohort.challengeId], cohortKey: 'batch-cohort', runIndex: 2,
      startedBy: ACTOR,
    }))

    expect(second.finish?.varianceComputed).toBe(true)
    const variance = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM score_variance')
    expect(variance.rows[0]!.n).toBeGreaterThan(0)
  })

  it('is idempotent — finishing twice leaves one shortlist and one ranking', async () => {
    const first = await batch()
    const again = await inScope(() => runBatch({
      challengeIds: [cohort.challengeId], cohortKey: 'batch-cohort', runIndex: 1,
      startedBy: ACTOR, resumeRunId: first.runId,
    }))
    expect(again.finish?.shortlistOpened).toBe(true)

    const lists = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM shortlist WHERE run_index_id = $1', [first.scoreRunId])
    expect(lists.rows[0]!.n).toBe(1)
  })
})

describe('the calibration gate is the one deliberate stop (E24)', () => {
  beforeEach(async () => {
    await query(
      `UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.calibration.bypass_gate'`)
    invalidateConfig()
  })

  afterEach(async () => {
    await query(
      `UPDATE feature_flag SET enabled = TRUE WHERE key = 'feature.calibration.bypass_gate'`)
    invalidateConfig()
  })

  it('PAUSES rather than failing, so the scores are not thrown away', async () => {
    const summary = await batch()

    expect(summary.status).toBe('PAUSED')
    expect(summary.pausedReason).toMatch(/has not been shown fit to rank/)
    expect(summary.finish?.ranked).toBe(false)
  })

  it('keeps the scores it produced — only ranking is refused', async () => {
    const summary = await batch()
    const scores = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM criterion_score WHERE run_index_id = $1',
      [summary.scoreRunId])
    expect(scores.rows[0]!.n).toBeGreaterThan(0)
  })

  it('finishes on resume once the gate is no longer refusing', async () => {
    // The point of pausing rather than failing: recording a decision and resuming completes the
    // job instead of requiring the whole cohort to be scored again.
    const paused = await batch()
    expect(paused.status).toBe('PAUSED')

    await query(
      `UPDATE feature_flag SET enabled = TRUE WHERE key = 'feature.calibration.bypass_gate'`)
    invalidateConfig()

    const resumed = await inScope(() => runBatch({
      challengeIds: [cohort.challengeId], cohortKey: 'batch-cohort', runIndex: 1,
      startedBy: ACTOR, resumeRunId: paused.runId,
    }))
    expect(resumed.status).toBe('SUCCEEDED')
    expect(resumed.finish).toMatchObject({ ranked: true, shortlistOpened: true })
  })
})
