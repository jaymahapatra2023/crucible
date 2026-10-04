/**
 * Run ledger integration tests (E01-S05).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import {
  accrueCost, closeRun, completedSubjects, getRunDetail, getRuns, openRun, stage, stageOutcome,
} from '../../src/modules/platform/services/runLedgerService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
})

const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
  withCorrelation({ correlationId: 'test-correlation-id' }, fn)

describe('run lifecycle', () => {
  it('opens a run in RUNNING and records who started it', async () => {
    const run = await inScope(() => openRun({ kind: 'COHORT', startedBy: 'op@test.local' }))
    expect(run.status).toBe('RUNNING')
    expect(run.startedBy).toBe('op@test.local')
    expect(run.correlationId).toBe('test-correlation-id')
  })

  it('records the four stage outcomes (acceptance 1)', async () => {
    const run = await inScope(() => openRun({ kind: 'SCAN' }))
    await stage({ runId: run.runId, stage: 'ok-stage' }, async () => 'done')
    await stage({ runId: run.runId, stage: 'warn-stage' }, async () =>
      stageOutcome('warning', 'partial coverage'))
    await stage({ runId: run.runId, stage: 'skip-stage' }, async () =>
      stageOutcome('skipped', 'already complete'))
    await expect(
      stage({ runId: run.runId, stage: 'fail-stage' }, async () => { throw new Error('nope') }),
    ).rejects.toThrow('nope')

    const detail = await getRunDetail(run.runId)
    const byStage = Object.fromEntries(detail.stages.map((s) => [s.stage, s.outcome]))
    expect(byStage).toEqual({
      'ok-stage': 'ok', 'warn-stage': 'warning',
      'skip-stage': 'skipped', 'fail-stage': 'failed',
    })
    expect(detail.progress.okCount).toBe(1)
    expect(detail.progress.failedCount).toBe(1)
  })

  it('records a failure and rethrows, so the caller decides whether the run continues', async () => {
    const run = await inScope(() => openRun({ kind: 'SCORE' }))
    await expect(
      stage({ runId: run.runId, stage: 's', subjectId: 'sub-1' }, async () => {
        throw new Error('scoring blew up')
      }),
    ).rejects.toThrow('scoring blew up')

    const detail = await getRunDetail(run.runId)
    expect(detail.stages[0]?.outcome).toBe('failed')
    expect(detail.stages[0]?.message).toContain('scoring blew up')
  })

  it('RETURNS the stage result even when the ledger write is impossible', async () => {
    /*
     * Bookkeeping must not destroy the work it records. The failure path has always been guarded
     * for this reason; the success path was not, so an unwritable ledger turned a check that had
     * succeeded into a failed one. Seen in the wild as a foreign-key violation when a run was
     * removed while its drain was still in flight: the pre-flight stayed RUNNING until the
     * watchdog gave up and emailed the team that their entry could not be checked.
     *
     * The run is deleted here, so the stage row cannot be written at all.
     */
    const run = await inScope(() => openRun({ kind: 'SCAN' }))
    await query('DELETE FROM run WHERE run_id = $1', [run.runId])

    const result = await inScope(() => stage(
      { runId: run.runId, stage: 'scan' },
      async () => ({ value: 'the work still happened', ...stageOutcome('ok', 'done') }),
    ))
    expect(result.value).toBe('the work still happened')

    // And nothing was recorded, which is the honest outcome — not a fabricated row.
    const rows = await query('SELECT 1 FROM run_stage_result WHERE run_id = $1', [run.runId])
    expect(rows.rows).toHaveLength(0)
  })

  it('captures stage timing', async () => {
    const run = await inScope(() => openRun({ kind: 'SCAN' }))
    await stage({ runId: run.runId, stage: 'timed' }, async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
    const detail = await getRunDetail(run.runId)
    expect(detail.stages[0]?.durationMs).toBeGreaterThanOrEqual(20)
  })

  it('survives a process restart — the ledger is in the database (acceptance 2)', async () => {
    const run = await inScope(() => openRun({ kind: 'COHORT' }))
    await stage({ runId: run.runId, stage: 'persisted', subjectId: 'x' }, async () => 'v')

    // Simulate a fresh process: read back with no in-memory state involved.
    const rows = await query(
      'SELECT stage, outcome FROM run_stage_result WHERE run_id = $1', [run.runId])
    expect(rows.rows).toEqual([{ stage: 'persisted', outcome: 'ok' }])
  })

  it('closes a run and stamps finished_at', async () => {
    const run = await inScope(() => openRun({ kind: 'SCAN' }))
    const closed = await closeRun(run.runId, 'SUCCEEDED')
    expect(closed.status).toBe('SUCCEEDED')
    expect(closed.finishedAt).not.toBeNull()
  })
})

describe('resume support (E10-S04)', () => {
  it('re-recording the same attempt updates rather than duplicating (acceptance 3)', async () => {
    const run = await inScope(() => openRun({ kind: 'COHORT' }))
    await stage({ runId: run.runId, stage: 'scan', subjectId: 'sub-1' }, async () => 'a')
    await stage({ runId: run.runId, stage: 'scan', subjectId: 'sub-1' }, async () => 'b')

    const rows = await query(
      `SELECT COUNT(*)::int AS n FROM run_stage_result
        WHERE run_id = $1 AND stage = 'scan' AND subject_id = 'sub-1'`, [run.runId])
    expect(rows.rows[0]).toEqual({ n: 1 })
  })

  it('distinguishes attempts, so a retry is visible rather than overwriting history', async () => {
    const run = await inScope(() => openRun({ kind: 'COHORT' }))
    await stage({ runId: run.runId, stage: 'scan', subjectId: 's', attempt: 1 }, async () => 'a')
    await stage({ runId: run.runId, stage: 'scan', subjectId: 's', attempt: 2 }, async () => 'b')
    const detail = await getRunDetail(run.runId)
    expect(detail.stages).toHaveLength(2)
  })

  it('reports completed subjects so a resume can skip them (acceptance 2)', async () => {
    const run = await inScope(() => openRun({ kind: 'COHORT' }))
    await stage({ runId: run.runId, stage: 'scan', subjectId: 'a' }, async () => 1)
    await stage({ runId: run.runId, stage: 'scan', subjectId: 'b' }, async () => stageOutcome('skipped'))
    await expect(
      stage({ runId: run.runId, stage: 'scan', subjectId: 'c' }, async () => { throw new Error('x') }),
    ).rejects.toThrow()

    const done = await completedSubjects(run.runId, 'scan')
    expect([...done].sort()).toEqual(['a', 'b'])
    expect(done.has('c')).toBe(false)
  })
})

describe('cost accrual (E10-S03)', () => {
  it('accumulates additively so concurrent workers cannot clobber each other', async () => {
    const run = await inScope(() => openRun({ kind: 'SCORE' }))
    await Promise.all(Array.from({ length: 10 }, () => accrueCost(run.runId, 0.25)))
    const detail = await getRunDetail(run.runId)
    expect(detail.run.costUsd).toBeCloseTo(2.5, 6)
  })

  it('ignores a non-positive delta', async () => {
    const run = await inScope(() => openRun({ kind: 'SCORE' }))
    await accrueCost(run.runId, 0)
    await accrueCost(run.runId, -5)
    expect((await getRunDetail(run.runId)).run.costUsd).toBe(0)
  })
})

describe('listing', () => {
  it('returns a real backend total, not the page length (P5.7)', async () => {
    for (let i = 0; i < 5; i++) await inScope(() => openRun({ kind: 'SCAN' }))
    const { runs, total } = await getRuns(2, 0)
    expect(runs).toHaveLength(2)
    expect(total).toBe(5)
  })

  it('filters by kind with a matching total', async () => {
    await inScope(() => openRun({ kind: 'SCAN' }))
    await inScope(() => openRun({ kind: 'PROBE' }))
    await inScope(() => openRun({ kind: 'PROBE' }))
    const { runs, total } = await getRuns(10, 0, 'PROBE')
    expect(runs).toHaveLength(2)
    expect(total).toBe(2)
  })
})
