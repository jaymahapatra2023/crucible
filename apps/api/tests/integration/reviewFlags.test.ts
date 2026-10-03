/**
 * Review flags (E08-S03).
 *
 * The story's demand is that "nothing silently shapes the outcome". These tests therefore check
 * that each caveat actually reaches the flag list from its own module, that the wording is
 * something a person can act on rather than a code, and that setting one aside leaves a record.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { dismissFlag, listFlags } from '../../src/modules/review/services/flagService.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, insufficientTurn, originalityTurn, scanResult, scannedFile, scoreTurn,
  seedCohort, seedScan, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
let cohortKey: string
let runId: number

async function rankedRun(scores: Array<{ text: string }>): Promise<number> {
  provider.setScript(scores)
  const outcome = await inScope(() => startRun({
    cohortKey, runIndex: 1, submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  await computeRanking(outcome.run.run_index_id, ACTOR)
  return outcome.run.run_index_id
}

const normalRun = () =>
  rankedRun([4, 3].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))

const codesFor = async (submissionId: number): Promise<string[]> =>
  (await listFlags(runId, submissionId)).map((f) => f.code)

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  cohortKey = `flags-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  cohort = await seedCohort({ count: 2 })
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('caveats reach the flag list from every module (acceptance 1)', () => {
  it('raises COHORT_BELOW_FLOOR from the scoring module', async () => {
    runId = await normalRun()
    expect(await codesFor(cohort.submissionIds[0]!)).toContain('COHORT_BELOW_FLOOR')
  })

  it('raises SCAN_TRUNCATED from the scanner', async () => {
    await query('DELETE FROM scan WHERE submission_id = $1', [cohort.submissionIds[0]!])
    await seedScan(cohort.submissionIds[0]!, scanResult(
      [scannedFile('src/retry.ts', 'export async function withRetry() { return 1 }')],
      { budgetTruncated: true, filesTotal: 400 },
    ))
    runId = await normalRun()

    const flags = await listFlags(runId, cohort.submissionIds[0]!)
    const truncated = flags.find((f) => f.code === 'SCAN_TRUNCATED')
    expect(truncated).toBeDefined()
    expect(truncated?.message).toMatch(/of 400 files/)
  })

  it('raises INSUFFICIENT_EVIDENCE from an unscoreable criterion', async () => {
    runId = await rankedRun([
      insufficientTurn(), originalityTurn(3), scoreTurn(3), originalityTurn(3),
    ])
    expect(await codesFor(cohort.submissionIds[0]!)).toContain('INSUFFICIENT_EVIDENCE')
  })

  it('raises NOT_PROBED when the submission was never built', async () => {
    runId = await normalRun()
    expect(await codesFor(cohort.submissionIds[0]!)).toContain('NOT_PROBED')
  })

  it('raises a PROVENANCE flag from the scanner’s own wording', async () => {
    await query(
      `INSERT INTO provenance (submission_id, scan_id, flags)
       VALUES ($1, (SELECT scan_id FROM scan WHERE submission_id = $1), $2::jsonb)`,
      [cohort.submissionIds[0]!, JSON.stringify([{
        code: 'NO_HISTORY',
        message: 'This submission has no readable git history, so when the work was done cannot be established.',
      }])])
    runId = await normalRun()

    const flags = await listFlags(runId, cohort.submissionIds[0]!)
    const provenance = flags.find((f) => f.code === 'PROVENANCE_NO_HISTORY')
    // Passed through verbatim, so the innocent explanation the scanner attached survives.
    expect(provenance?.message).toMatch(/no readable git history/)
  })
})

describe('the wording (acceptance 2)', () => {
  beforeEach(async () => {
    runId = await normalRun()
  })

  it('says what every flag MEANS, not merely what it is called', async () => {
    for (const flag of await listFlags(runId)) {
      expect(flag.message.length, flag.code).toBeGreaterThan(60)
      expect(flag.message, flag.code).not.toBe(flag.code)
      expect(flag.message, flag.code).toMatch(/\s/)
    }
  })

  it('explains that an unmeasured dimension was EXCLUDED, not scored zero', async () => {
    const notProbed = (await listFlags(runId)).find((f) => f.code === 'NOT_PROBED')
    expect(notProbed?.message).toMatch(/rather than scored zero/)
  })

  it('keeps the figures behind the message, so it can be checked', async () => {
    const cohortFlag = (await listFlags(runId)).find((f) => f.code === 'COHORT_BELOW_FLOOR')
    expect(cohortFlag?.detail).toMatchObject({ cohortSize: 2, floor: 15 })
  })

  it('classifies flags by whether they ask for a look', async () => {
    for (const flag of await listFlags(runId)) {
      expect(['ADVISORY', 'ATTENTION']).toContain(flag.severity)
    }
  })
})

describe('dismissal (acceptance 3)', () => {
  beforeEach(async () => {
    runId = await normalRun()
  })

  it('records who dismissed it and why', async () => {
    const row = await dismissFlag({
      runIndexId: runId,
      submissionId: cohort.submissionIds[0]!,
      code: 'COHORT_BELOW_FLOOR',
      actor: 'reviewer@test.local',
      reason: 'Both challenges were scored against the same absolute anchors; accepted.',
    })

    expect(row.dismissed).toBe(true)
    expect(row.dismissed_by).toBe('reviewer@test.local')
    expect(row.dismissal_reason).toMatch(/absolute anchors/)
  })

  it('writes an audit row carrying the reason AND the flag’s wording', async () => {
    await dismissFlag({
      runIndexId: runId,
      submissionId: cohort.submissionIds[0]!,
      code: 'COHORT_BELOW_FLOOR',
      actor: 'reviewer@test.local',
      reason: 'Both challenges were scored against the same absolute anchors; accepted.',
    })

    const audit = await query<{ payload: { reason: string; message: string } }>(
      `SELECT payload FROM audit_event WHERE action = 'review.flag_dismissed'`)
    expect(audit.rows[0]?.payload.reason).toMatch(/absolute anchors/)
    expect(audit.rows[0]?.payload.message).toMatch(/below the 15 needed/)
  })

  it('the DATABASE refuses a dismissal with no reason', async () => {
    await expect(query(
      `UPDATE review_flag SET dismissed_at = now(), dismissed_by = 'x'
        WHERE run_index_id = $1`, [runId],
    )).rejects.toThrow()
  })

  it('the DATABASE refuses a reason too short to mean anything', async () => {
    await expect(query(
      `UPDATE review_flag
          SET dismissed_at = now(), dismissed_by = 'x', dismissal_reason = 'fine'
        WHERE run_index_id = $1`, [runId],
    )).rejects.toThrow()
  })

  it('404s a flag that was never raised', async () => {
    await expect(dismissFlag({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      code: 'NOT_A_REAL_FLAG', actor: ACTOR,
      reason: 'This flag does not exist on this submission.',
    })).rejects.toThrow(/No 'NOT_A_REAL_FLAG' flag/)
  })

  it('KEEPS a dismissal when the ranking is recomputed', async () => {
    await dismissFlag({
      runIndexId: runId,
      submissionId: cohort.submissionIds[0]!,
      code: 'COHORT_BELOW_FLOOR',
      actor: 'reviewer@test.local',
      reason: 'Both challenges were scored against the same absolute anchors; accepted.',
    })

    await computeRanking(runId, ACTOR)

    const flags = await listFlags(runId, cohort.submissionIds[0]!)
    const cohortFlag = flags.find((f) => f.code === 'COHORT_BELOW_FLOOR')
    // A reviewer who has already answered this should not be asked again because an unrelated
    // submission was re-scored.
    expect(cohortFlag?.dismissed).toBe(true)
    expect(cohortFlag?.dismissal_reason).toMatch(/absolute anchors/)
  })

  it('DROPS a dismissal when the flag itself no longer applies', async () => {
    await dismissFlag({
      runIndexId: runId,
      submissionId: cohort.submissionIds[0]!,
      code: 'COHORT_BELOW_FLOOR',
      actor: 'reviewer@test.local',
      reason: 'Accepted for now; the cohort should grow before the final run.',
    })

    // Lower the floor so the cohort clears it, then re-rank.
    await inScope(() => setConfig('scoring.min_cohort_size', 1, ACTOR))
    invalidateConfig()
    await computeRanking(runId, ACTOR)

    expect(await codesFor(cohort.submissionIds[0]!)).not.toContain('COHORT_BELOW_FLOOR')
  })
})
