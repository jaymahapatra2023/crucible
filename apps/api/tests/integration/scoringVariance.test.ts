/**
 * The double run, the composite and run-to-run variance (E06-S06, E07-S01 … E07-S04).
 *
 * The behaviour under test is what happens when the system disagrees with itself. A submission
 * the scorer cannot place consistently is the case where automation quietly decides something it
 * has no business deciding, so these tests are mostly about the flags that route it to a person.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { compositesForRun } from '../../src/modules/scoring/services/compositeService.js'
import {
  computeVariance, dismissFlag, listOpenFlags,
} from '../../src/modules/scoring/services/varianceService.js'
import { selectRunsForCohort } from '../../src/modules/scoring/db/scoringDb.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
let cohortKey: string

/** Score every submission in a run, giving submission *i* the score at index *i*. */
async function runWith(runIndex: 1 | 2, scores: number[]): Promise<number> {
  // Each submission takes one criterion call and one advisory originality call, and the two
  // expect different response shapes — feeding a criterion response to the originality schema
  // fails validation, retries, and silently eats the NEXT submission's scripted turns.
  provider.setScript(scores.flatMap((score) => [scoreTurn(score), originalityTurn(3)]))
  const outcome = await inScope(() => startRun({
    cohortKey, runIndex, submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  // Variance compares the STORED rankings, so each run is ranked as part of completing it.
  await computeRanking(outcome.run.run_index_id, ACTOR)
  return outcome.run.run_index_id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  cohortKey = `cohort-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  cohort = await seedCohort({ count: 4 })
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('two independent runs per cohort (acceptance 1)', () => {
  it('records run 1 and run 2 separately', async () => {
    await runWith(1, [4, 3, 2, 1])
    await runWith(2, [4, 3, 2, 1])

    const runs = await selectRunsForCohort(cohortKey)
    expect(runs.map((r) => r.run_index)).toEqual([1, 2])
    expect(runs[0]!.run_index_id).not.toBe(runs[1]!.run_index_id)
  })

  it('pins the rubric version each run was judged by (P4.4)', async () => {
    await runWith(1, [4, 3, 2, 1])
    const [run] = await selectRunsForCohort(cohortKey)
    expect(run!.rubric_versions[String(cohort.challengeId)]).toBe(1)
  })

  it('REFUSES a third run under an index that already exists', async () => {
    await runWith(1, [4, 3, 2, 1])
    provider.setScript([scoreTurn(4)])
    await expect(inScope(() => startRun({
      cohortKey, runIndex: 1, submissionIds: cohort.submissionIds, startedBy: ACTOR,
    }))).rejects.toThrow(/already has run 1/)
  })

  it('the database refuses a duplicate (cohort, run index) outright', async () => {
    await runWith(1, [4, 3, 2, 1])
    await expect(query(
      `INSERT INTO score_run (run_index, cohort_key, model) VALUES (1, $1, 'x')`, [cohortKey],
    )).rejects.toThrow()
  })

  it('REFUSES to score against a challenge with no frozen rubric', async () => {
    // A frozen rubric cannot be un-frozen (E02-S07), so the case is built rather than undone:
    // a submission against a challenge whose rubric never reached FROZEN.
    const unfrozen = await query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, status) VALUES ('Unfrozen', 'unfrozen', 'OPEN')
       RETURNING challenge_id`)
    const orphan = await query<{ submission_id: number }>(
      `WITH t AS (
         INSERT INTO team (display_name, contact_email, origin, created_by)
         VALUES ('Orphan', 'o@test.local', 'ORGANISER', 'fixture') RETURNING team_id
       )
       INSERT INTO submission
         (team_id, team_name, contact_email, challenge_id, repo_url, build_method, build_command,
          validation_status)
       SELECT t.team_id, 'Orphan', 'o@test.local', $1, 'https://github.com/x/y', 'COMMAND',
              'npm ci', 'VALID' FROM t
       RETURNING submission_id`,
      [unfrozen.rows[0]!.challenge_id])

    await expect(inScope(() => startRun({
      cohortKey, runIndex: 1,
      submissionIds: [orphan.rows[0]!.submission_id], startedBy: ACTOR,
    }))).rejects.toThrow(/No frozen rubric/)
  })

  it('keeps going when ONE submission cannot be scored', async () => {
    // No scan for the last submission: it fails, the other three still produce scores.
    await query('DELETE FROM scan WHERE submission_id = $1', [cohort.submissionIds[3]!])
    provider.setScript([4, 3, 2].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))

    const outcome = await inScope(() => startRun({
      cohortKey, runIndex: 1, submissionIds: cohort.submissionIds, startedBy: ACTOR,
    }))

    expect(outcome.summaries).toHaveLength(3)
    expect(outcome.failedSubmissions).toHaveLength(1)
    expect(outcome.run.status).toBe('COMPLETED')
  })
})

describe('the composite and the ranking (E07-S04)', () => {
  it('ranks submissions by composite', async () => {
    const runId = await runWith(1, [4, 3, 2, 1])
    const { ranked } = await compositesForRun(runId)

    expect(ranked.map((r) => r.submissionId)).toEqual(cohort.submissionIds)
    expect(ranked[0]!.rankGlobal).toBe(1)
    expect(ranked[0]!.composite).toBeGreaterThan(ranked[3]!.composite)
  })

  it('does NOT mark anyone as selected (acceptance 3)', async () => {
    const runId = await runWith(1, [4, 3, 2, 1])
    const { ranked } = await compositesForRun(runId)
    for (const entry of ranked) {
      expect(entry).not.toHaveProperty('selected')
      expect(entry).not.toHaveProperty('shortlisted')
    }
  })

  it('falls back to absolute scoring below the cohort floor, and SAYS so (E07-S03)', async () => {
    const runId = await runWith(1, [4, 3, 2, 1])
    const { ranked, fallbackChallenges } = await compositesForRun(runId)

    // Four submissions is far below the floor of fifteen.
    expect(fallbackChallenges).toContain(cohort.challengeId)
    expect(ranked[0]!.normalisationMethod).toBe('ABSOLUTE_FALLBACK')
  })

  it('ALWAYS preserves the raw fidelity score for appeals (E07-S02 acceptance 3)', async () => {
    const runId = await runWith(1, [4, 3, 2, 1])
    const { ranked } = await compositesForRun(runId)
    expect(ranked[0]!.fidelityRaw).toBe(100)
  })

  it('is deterministic — the same stored scores rank the same way twice', async () => {
    const runId = await runWith(1, [4, 3, 2, 1])
    const first = await compositesForRun(runId)
    const second = await compositesForRun(runId)
    expect(first.ranked.map((r) => r.submissionId))
      .toEqual(second.ranked.map((r) => r.submissionId))
  })
})

describe('variance between the runs (acceptance 2, 3, 4)', () => {
  it('REFUSES to compare against a run with no stored ranking', async () => {
    await runWith(1, [4, 3, 2, 1])
    provider.setScript([4, 3, 2, 1].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
    await inScope(() => startRun({
      cohortKey, runIndex: 2, submissionIds: cohort.submissionIds, startedBy: ACTOR,
    }))
    await expect(computeVariance(cohortKey)).rejects.toThrow(/no stored ranking/)
  })

  it('REFUSES to compare when only one run exists', async () => {
    await runWith(1, [4, 3, 2, 1])
    await expect(computeVariance(cohortKey)).rejects.toThrow(/needs both run 1 and run 2/)
  })

  it('computes the composite delta per submission (acceptance 2)', async () => {
    await runWith(1, [4, 4, 2, 1])
    await runWith(2, [4, 2, 2, 1])

    await computeVariance(cohortKey)

    const rows = await query<{ submission_id: number; delta: number }>(
      'SELECT submission_id, delta FROM score_variance WHERE cohort_key = $1', [cohortKey])
    const byId = new Map(rows.rows.map((r) => [r.submission_id, Number(r.delta)]))

    expect(byId.get(cohort.submissionIds[0]!)).toBe(0)
    expect(byId.get(cohort.submissionIds[1]!)).toBe(50) // 4 → 2 is 100 → 50
  })

  it('FLAGS a submission whose two runs straddle the cut line (acceptance 3)', async () => {
    await inScope(() => setConfig('scoring.cut_line', 2, ACTOR))
    invalidateConfig()

    await runWith(1, [4, 3, 2, 1])
    await runWith(2, [4, 1, 3, 2])

    const summary = await computeVariance(cohortKey)
    expect(summary.straddling).toBeGreaterThan(0)

    const open = await listOpenFlags(cohortKey)
    expect(open.some((f) => f.straddles_cut)).toBe(true)
  })

  it('FLAGS a large delta regardless of position (acceptance 4)', async () => {
    await inScope(() => setConfig('scoring.cut_line', 1, ACTOR))
    await inScope(() => setConfig('scoring.variance_delta_threshold', 10, ACTOR))
    invalidateConfig()

    // The last-placed submission swings hard but stays last in both runs.
    await runWith(1, [4, 4, 4, 3])
    await runWith(2, [4, 4, 4, 0])

    const summary = await computeVariance(cohortKey)
    const open = await listOpenFlags(cohortKey)
    const flagged = open.find((f) => f.submission_id === cohort.submissionIds[3])

    expect(flagged?.exceeds_threshold).toBe(true)
    expect(summary.exceeding).toBeGreaterThan(0)
  })

  it('records the threshold and cut line in force, so the flag stays explicable', async () => {
    await runWith(1, [4, 3, 2, 1])
    await runWith(2, [1, 2, 3, 4])
    await computeVariance(cohortKey)

    const [row] = (await query<{ threshold_used: number; cut_line_used: number }>(
      'SELECT threshold_used, cut_line_used FROM score_variance WHERE cohort_key = $1 LIMIT 1',
      [cohortKey])).rows
    expect(Number(row!.threshold_used)).toBe(10)
    expect(row!.cut_line_used).toBe(25)
  })

  it('reports submissions present in only one run rather than dropping them silently', async () => {
    await runWith(1, [4, 3, 2, 1])
    // Run 2 scores only three of the four.
    provider.setScript([4, 3, 2].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
    const partial = await inScope(() => startRun({
      cohortKey, runIndex: 2, submissionIds: cohort.submissionIds.slice(0, 3), startedBy: ACTOR,
    }))
    await computeRanking(partial.run.run_index_id, ACTOR)

    const summary = await computeVariance(cohortKey)
    expect(summary.unmatched).toContain(cohort.submissionIds[3])
    expect(summary.compared).toBe(3)
  })
})

describe('dismissing a flag (acceptance 5)', () => {
  beforeEach(async () => {
    await inScope(() => setConfig('scoring.cut_line', 2, ACTOR))
    invalidateConfig()
    await runWith(1, [4, 3, 2, 1])
    await runWith(2, [4, 1, 3, 2])
    await computeVariance(cohortKey)
  })

  it('records who dismissed it and why', async () => {
    const row = await dismissFlag({
      cohortKey,
      submissionId: cohort.submissionIds[1]!,
      actor: 'reviewer@test.local',
      reason: 'Both runs cite the same evidence; the anchor wording is the difference.',
    })

    expect(row.dismissed_by).toBe('reviewer@test.local')
    expect(row.dismissal_reason).toMatch(/anchor wording/)
    expect(row.dismissed_at).not.toBeNull()
  })

  it('writes an audit row naming the reason', async () => {
    await dismissFlag({
      cohortKey,
      submissionId: cohort.submissionIds[1]!,
      actor: 'reviewer@test.local',
      reason: 'Both runs cite the same evidence; the anchor wording is the difference.',
    })

    const audit = await query<{ action: string; payload: { reason: string } }>(
      `SELECT action, payload FROM audit_event
        WHERE action = 'scoring.variance_flag_dismissed'`)
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]!.payload.reason).toMatch(/anchor wording/)
  })

  it('REMOVES it from the open list once dismissed', async () => {
    const before = await listOpenFlags(cohortKey)
    await dismissFlag({
      cohortKey,
      submissionId: before[0]!.submission_id,
      actor: 'reviewer@test.local',
      reason: 'Reviewed both runs against the evidence and accept the lower placement.',
    })
    const after = await listOpenFlags(cohortKey)
    expect(after).toHaveLength(before.length - 1)
  })

  it('the DATABASE refuses a dismissal with no reason at all', async () => {
    await expect(query(
      `UPDATE score_variance SET dismissed_at = now(), dismissed_by = 'x'
        WHERE cohort_key = $1`, [cohortKey],
    )).rejects.toThrow()
  })

  it('the DATABASE refuses a reason too short to mean anything', async () => {
    await expect(query(
      `UPDATE score_variance
          SET dismissed_at = now(), dismissed_by = 'x', dismissal_reason = '   ok   '
        WHERE cohort_key = $1`, [cohortKey],
    )).rejects.toThrow()
  })

  it('KEEPS a dismissal when the cohort is recomputed', async () => {
    const [flag] = await listOpenFlags(cohortKey)
    await dismissFlag({
      cohortKey,
      submissionId: flag!.submission_id,
      actor: 'reviewer@test.local',
      reason: 'Checked the evidence for both runs; the difference is not material.',
    })

    await computeVariance(cohortKey)

    const rows = await query<{ dismissal_reason: string | null }>(
      'SELECT dismissal_reason FROM score_variance WHERE cohort_key = $1 AND submission_id = $2',
      [cohortKey, flag!.submission_id])
    expect(rows.rows[0]!.dismissal_reason).toMatch(/not material/)
  })
})
