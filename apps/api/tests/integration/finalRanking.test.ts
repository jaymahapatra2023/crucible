/**
 * The final ranking of a cohort from its two runs (E50).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { insertScoreRun } from '../../src/modules/scoring/db/scoringDb.js'
import { replaceRanking, type CompositeInsert } from '../../src/modules/scoring/db/rankingDb.js'
import { computeFinalRanking, getFinalRanking } from '../../src/modules/scoring/services/finalRankingService.js'
import { seedCohort, type CohortFixture } from '../support/scoringFixtures.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import { query } from '../../src/db/pool.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'final' }, fn)
let cohort: CohortFixture

const composite = (submissionId: number, challengeId: number, composite: number, rank: number): CompositeInsert => ({
  submissionId, challengeId, composite, fidelityRaw: 70, fidelityNormalised: 80, cohortSize: 3,
  normalisationMethod: 'PERCENTILE', rankGlobal: rank, rankInChallenge: rank, tied: false,
  weightCovered: 1, missingDimensions: [], partial: false, inCutBand: false, advisoryDecided: false,
  reviewReasons: [],
})

async function rankedRun(runIndex: 1 | 2, composites: number[]): Promise<number> {
  const run = await insertScoreRun({
    runIndex, cohortKey: 'cohort-a', rubricVersions: {}, model: 'test', ledgerRunId: null, startedBy: ACTOR,
  })
  const ordered = cohort.submissionIds.map((id, i) => ({ id, c: composites[i]! })).sort((a, b) => b.c - a.c)
  await replaceRanking(run.run_index_id,
    ordered.map((o, i) => composite(o.id, cohort.challengeId, o.c, i + 1)),
    { scoresCounted: 3, submissions: 3, cutLineUsed: 2, bandSizeUsed: 1, minCohortSize: 1, computedBy: ACTOR })
  return run.run_index_id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  await setFlag('feature.calibration.bypass_gate', true, ACTOR)
  await setConfig('scoring.cut_line', 2, ACTOR)
  invalidateConfig()
  cohort = await seedCohort({ count: 3 })
})

describe('computing', () => {
  it('needs both runs ranked, and says which is missing', async () => {
    await expect(inScope(() => computeFinalRanking('cohort-a', ACTOR))).rejects.toThrow(/needs both run 1 and run 2/)
    await rankedRun(1, [80, 70, 60])
    await insertScoreRun({ runIndex: 2, cohortKey: 'cohort-a', rubricVersions: {}, model: 'test', ledgerRunId: null, startedBy: ACTOR })
    await expect(inScope(() => computeFinalRanking('cohort-a', ACTOR))).rejects.toThrow(/Run 2 .* has no stored ranking/)
  })

  it('stores the weighted mean, ranked, with both composites and disagreement beside it', async () => {
    await rankedRun(1, [80, 70, 60])
    await rankedRun(2, [60, 90, 60])
    const view = await inScope(() => computeFinalRanking('cohort-a', ACTOR))

    expect(view.ranked.map((r) => [r.submission_id, r.composite_final, r.rank_global])).toEqual([
      [cohort.submissionIds[1], 80, 1], [cohort.submissionIds[0], 70, 2], [cohort.submissionIds[2], 60, 3],
    ])
    const second = view.ranked.find((r) => r.submission_id === cohort.submissionIds[1])!
    expect(second).toMatchObject({ composite_run1: 70, composite_run2: 90, delta: 20, disagreement: true })
    expect(view.snapshot).toMatchObject({ weights: { 1: 0.5, 2: 0.5 }, cut_line_used: 2, submissions: 3 })
    expect(view.stale).toBe(false)

    const audit = await query<{ payload: { disagreements: number } }>(
      `SELECT payload FROM audit_event WHERE action = 'scoring.final_ranking_computed'`)
    // Both of the top two moved by 20 between runs; the third did not.
    expect(audit.rows[0]!.payload.disagreements).toBe(2)
  })

  it('reads the weights from configuration and refuses ones that do not sum to 1', async () => {
    await rankedRun(1, [80, 70, 60])
    await rankedRun(2, [40, 70, 60])
    await setConfig('scoring.run_weights', { 1: 0.25, 2: 0.75 }, ACTOR)
    invalidateConfig()
    const view = await inScope(() => computeFinalRanking('cohort-a', ACTOR))
    expect(view.ranked.find((r) => r.submission_id === cohort.submissionIds[0])!.composite_final).toBe(50)

    await setConfig('scoring.run_weights', { 1: 0.7, 2: 0.7 }, ACTOR)
    invalidateConfig()
    await expect(inScope(() => computeFinalRanking('cohort-a', ACTOR))).rejects.toThrow(/sum to 1/)
  })

  it('is marked stale when a run is re-ranked afterwards, and recomputing clears it', async () => {
    const r1 = await rankedRun(1, [80, 70, 60])
    await rankedRun(2, [80, 70, 60])
    await inScope(() => computeFinalRanking('cohort-a', ACTOR))
    await new Promise((r) => setTimeout(r, 20))
    await replaceRanking(r1, cohort.submissionIds.map((id, i) => composite(id, cohort.challengeId, 90 - i, i + 1)),
      { scoresCounted: 3, submissions: 3, cutLineUsed: 2, bandSizeUsed: 1, minCohortSize: 1, computedBy: ACTOR })
    expect((await getFinalRanking('cohort-a')).stale).toBe(true)
    expect((await inScope(() => computeFinalRanking('cohort-a', ACTOR))).stale).toBe(false)
  })

  it('reports an empty view, not an error, for a cohort never combined', async () => {
    const view = await getFinalRanking('nothing-here')
    expect(view).toMatchObject({ ranked: [], snapshot: null, stale: false, runs: { run1IndexId: null, run2IndexId: null } })
  })
})
