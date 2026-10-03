/**
 * Ranking, cohorts, split reporting and the cut-line band (E07).
 *
 * E07 turns scores into positions, and a position is the thing a team can appeal. So the tests
 * concentrate on what has to remain true months later: the cohort a submission was normalised
 * against, the raw fidelity score beside the normalised one, and a ranking that says when it no
 * longer matches the scores rather than quietly presenting itself as current.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import {
  computeRanking, cutBandReport, storedRanking,
} from '../../src/modules/scoring/services/rankingService.js'
import { splitReport } from '../../src/modules/scoring/services/splitReport.js'
import { exportRanking } from '../../src/modules/scoring/services/rankingExport.js'
import { selectCohorts } from '../../src/modules/scoring/db/rankingDb.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
let cohortKey: string
let runId: number

async function scoreRun(scores: number[], ids?: number[]): Promise<number> {
  provider.setScript(scores.flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
  const outcome = await inScope(() => startRun({
    cohortKey, runIndex: 1, submissionIds: ids ?? cohort.submissionIds, startedBy: ACTOR,
  }))
  return outcome.run.run_index_id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  cohortKey = `rank-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  cohort = await seedCohort({ count: 4 })
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('cohort sizes recorded BEFORE scoring (E07-S03 acceptance 1)', () => {
  it('records the size and the floor that applied', async () => {
    runId = await scoreRun([4, 3, 2, 1])
    const [cohortRow] = await selectCohorts(runId)

    expect(cohortRow?.challenge_id).toBe(cohort.challengeId)
    expect(cohortRow?.cohort_size).toBe(4)
    expect(cohortRow?.floor_used).toBe(15)
    expect(cohortRow?.below_floor).toBe(true)
  })

  it('counts only the submissions the RUN covers, not the challenge total', async () => {
    runId = await scoreRun([4, 3], cohort.submissionIds.slice(0, 2))
    const [cohortRow] = await selectCohorts(runId)
    // Two were scored; four exist. A submission left out of the run was not in its cohort.
    expect(cohortRow?.cohort_size).toBe(2)
  })

  it('records the floor IN FORCE, so retuning cannot rewrite history', async () => {
    await inScope(() => setConfig('scoring.min_cohort_size', 3, ACTOR))
    invalidateConfig()
    runId = await scoreRun([4, 3, 2, 1])

    await inScope(() => setConfig('scoring.min_cohort_size', 50, ACTOR))
    invalidateConfig()

    const [cohortRow] = await selectCohorts(runId)
    expect(cohortRow?.floor_used).toBe(3)
    expect(cohortRow?.below_floor).toBe(false)
  })
})

describe('the stored ranking (E07-S02 acceptance 3, E07-S04 acceptance 1)', () => {
  beforeEach(async () => {
    runId = await scoreRun([4, 3, 2, 1])
  })

  it('stores rank_global AND rank_in_challenge', async () => {
    await computeRanking(runId, ACTOR)
    const { ranked } = await storedRanking(runId)

    expect(ranked.map((r) => r.rank_global)).toEqual([1, 2, 3, 4])
    expect(ranked.map((r) => r.rank_in_challenge)).toEqual([1, 2, 3, 4])
  })

  it('PERSISTS both the raw and the normalised fidelity (acceptance 3)', async () => {
    await computeRanking(runId, ACTOR)
    const [top] = await storedRanking(runId).then((r) => r.ranked)

    expect(Number(top?.fidelity_raw)).toBe(100)
    expect(top?.fidelity_normalised).not.toBeNull()
  })

  it('records the method, so an absolute fallback is never mistaken for a percentile', async () => {
    await computeRanking(runId, ACTOR)
    const { ranked, fallbackChallenges } = await storedRanking(runId)
    expect(ranked[0]?.normalisation_method).toBe('ABSOLUTE_FALLBACK')
    expect(fallbackChallenges).toContain(cohort.challengeId)
  })

  it('the database refuses two submissions at the same rank', async () => {
    await computeRanking(runId, ACTOR)
    const [top] = await storedRanking(runId).then((r) => r.ranked)
    await expect(query(
      'UPDATE submission_composite SET rank_global = 1 WHERE submission_id <> $1 AND run_index_id = $2',
      [top!.submission_id, runId],
    )).rejects.toThrow()
  })

  it('REPLACES the previous ranking rather than accumulating rows', async () => {
    await computeRanking(runId, ACTOR)
    await computeRanking(runId, ACTOR)

    const rows = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM submission_composite WHERE run_index_id = $1', [runId])
    expect(rows.rows[0]!.n).toBe(4)
  })

  it('is NOT stale immediately after being computed', async () => {
    await computeRanking(runId, ACTOR)
    expect((await storedRanking(runId)).stale).toBe(false)
  })

  it('reports STALE once scores change beneath it (P5.1)', async () => {
    await computeRanking(runId, ACTOR)
    await query('DELETE FROM criterion_score WHERE run_index_id = $1 AND submission_id = $2',
      [runId, cohort.submissionIds[3]])

    expect((await storedRanking(runId)).stale).toBe(true)
  })

  it('records who computed it and what it was computed from', async () => {
    await computeRanking(runId, ACTOR)
    const { snapshot } = await storedRanking(runId)

    expect(snapshot?.computed_by).toBe(ACTOR)
    expect(snapshot?.submissions).toBe(4)
    expect(snapshot?.scores_counted).toBeGreaterThan(0)
  })

  it('writes an audit row', async () => {
    await computeRanking(runId, ACTOR)
    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'scoring.ranking_computed'`)
    expect(audit.rows).toHaveLength(1)
  })

  it('REFUSES to rank a run with nothing scored', async () => {
    await query('DELETE FROM criterion_score WHERE run_index_id = $1', [runId])
    await expect(computeRanking(runId, ACTOR)).rejects.toThrow(/no scored submissions/)
  })

  it('stores NOTHING that marks a submission as selected (E07-S04 acceptance 3)', async () => {
    await computeRanking(runId, ACTOR)
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'submission_composite'`)
    const names = columns.rows.map((c) => c.column_name).join(' ')
    expect(names).not.toMatch(/select|shortlist|eliminat|winner/)
  })
})

describe('the cut-line band (E07-S06)', () => {
  beforeEach(async () => {
    await inScope(() => setConfig('scoring.cut_line', 2, ACTOR))
    await inScope(() => setConfig('scoring.cut_band_size', 1, ACTOR))
    invalidateConfig()
    runId = await scoreRun([4, 3, 2, 1])
    await computeRanking(runId, ACTOR)
  })

  it('labels a configurable band around the cut line (acceptance 1)', async () => {
    const report = await cutBandReport(runId)
    expect(report.cutLine).toBe(2)
    expect(report.bandSize).toBe(1)
    expect(report.band.map((r) => r.rank_global)).toEqual([1, 2, 3])
  })

  it('lists EVERY submission in the band for review (acceptance 2)', async () => {
    const flagged = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM submission_composite WHERE run_index_id = $1 AND in_cut_band',
      [runId])
    expect(flagged.rows[0]!.n).toBe(3)
  })

  it('records the band that applied, so retuning cannot rewrite it', async () => {
    await inScope(() => setConfig('scoring.cut_band_size', 99, ACTOR))
    invalidateConfig()
    expect((await cutBandReport(runId)).bandSize).toBe(1)
  })

  it('REFUSES before a ranking exists, rather than inventing one', async () => {
    await query('DELETE FROM ranking_snapshot WHERE run_index_id = $1', [runId])
    await expect(cutBandReport(runId)).rejects.toThrow(/no stored ranking/)
  })
})

describe('flagged for human review (E07-S03 acceptance 2, E07-S06 acceptance 2)', () => {
  beforeEach(async () => {
    runId = await scoreRun([4, 3, 2, 1])
    await computeRanking(runId, ACTOR)
  })

  it('flags EVERY submission whose cohort was too small to normalise', async () => {
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM submission_composite
        WHERE run_index_id = $1 AND requires_review
          AND 'COHORT_BELOW_FLOOR' = ANY(review_reasons)`, [runId])
    // All four: the cohort is four, the floor is fifteen.
    expect(rows.rows[0]!.n).toBe(4)
  })

  it('flags them WHEREVER they sit, not only near the cut line', async () => {
    const report = await cutBandReport(runId)
    // The default cut line is 25, so nothing here is in the band — yet all four need review.
    expect(report.band).toHaveLength(0)
    expect(report.requiresReview).toHaveLength(4)
  })

  it('spells the reasons out in plain language for the reviewer', async () => {
    const report = await cutBandReport(runId)
    expect(report.requiresReview[0]?.review_reason_text.join(' '))
      .toMatch(/cohort too small to normalise/)
  })

  it('the database REFUSES a flag with no reason attached', async () => {
    await expect(query(
      `UPDATE submission_composite SET requires_review = TRUE, review_reasons = '{}'
        WHERE run_index_id = $1`, [runId],
    )).rejects.toThrow()
  })

  it('the database REFUSES reasons on a submission not flagged', async () => {
    await expect(query(
      `UPDATE submission_composite SET requires_review = FALSE, review_reasons = '{TIED}'
        WHERE run_index_id = $1`, [runId],
    )).rejects.toThrow()
  })

  it('carries the flag and its reasons into the export', async () => {
    const csv = await exportRanking(runId)
    expect(csv.split('\n')[0]).toContain('requires_review')
    expect(csv.split('\n')[0]).toContain('review_reasons')
    expect(csv).toMatch(/cohort too small to normalise/)
  })
})

describe('challenge split reporting (E07-S05)', () => {
  it('breaks the shortlist down by challenge with medians alongside', async () => {
    const other = await seedCohort({ count: 3, name: 'Second challenge' })
    provider.setScript([4, 3, 2, 1, 4, 2, 0].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
    const outcome = await inScope(() => startRun({
      cohortKey, runIndex: 1,
      submissionIds: [...cohort.submissionIds, ...other.submissionIds], startedBy: ACTOR,
    }))
    runId = outcome.run.run_index_id
    await computeRanking(runId, ACTOR)

    const report = await splitReport(runId)
    expect(report.byChallenge).toHaveLength(2)
    expect(report.byChallenge.map((c) => c.inShortlist).reduce((a, b) => a + b, 0)).toBe(7)
    for (const row of report.byChallenge) expect(row.medianComposite).not.toBeNull()
  })

  it('raises a NON-BLOCKING advisory when one challenge dominates (acceptance 2)', async () => {
    const other = await seedCohort({ count: 1, name: 'Thin challenge' })
    provider.setScript([4, 4, 4, 4, 0].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
    const outcome = await inScope(() => startRun({
      cohortKey, runIndex: 1,
      submissionIds: [...cohort.submissionIds, ...other.submissionIds], startedBy: ACTOR,
    }))
    runId = outcome.run.run_index_id
    await computeRanking(runId, ACTOR)

    const report = await splitReport(runId)
    // Four of five is 80%, above the 70% default.
    expect(report.advisory).toMatch(/80% of the shortlist/)
    // Advisory, not a refusal: the report still returns everything.
    expect(report.byChallenge).toHaveLength(2)
  })

  it('says nothing when there is only one challenge to compare', async () => {
    runId = await scoreRun([4, 3, 2, 1])
    await computeRanking(runId, ACTOR)
    expect((await splitReport(runId)).advisory).toBeNull()
  })

  it('carries the cohort size and below-floor flag through', async () => {
    runId = await scoreRun([4, 3, 2, 1])
    await computeRanking(runId, ACTOR)

    const [row] = (await splitReport(runId)).byChallenge
    expect(row?.cohortSize).toBe(4)
    expect(row?.belowFloor).toBe(true)
  })

  it('REFUSES before a ranking exists', async () => {
    runId = await scoreRun([4, 3, 2, 1])
    await expect(splitReport(runId)).rejects.toThrow(/no stored ranking/)
  })
})

describe('the export (E07-S03 acceptance 3)', () => {
  beforeEach(async () => {
    runId = await scoreRun([4, 3, 2, 1])
    await computeRanking(runId, ACTOR)
  })

  it('carries the fallback, the cohort size and the raw fidelity', async () => {
    const csv = await exportRanking(runId)
    const [header, first] = csv.split('\n')

    expect(header).toContain('cohort_below_floor')
    expect(header).toContain('fidelity_raw')
    expect(header).toContain('normalisation_method')
    expect(first).toContain('ABSOLUTE_FALLBACK')
    expect(first).toContain('"YES"')
  })

  it('says "within_shortlist", never "selected" (E07-S04 acceptance 3)', async () => {
    const csv = await exportRanking(runId)
    expect(csv).toContain('within_shortlist')
    expect(csv).not.toMatch(/selected|shortlisted_final|winner/)
  })

  it('names the dimensions that could not be scored', async () => {
    const csv = await exportRanking(runId)
    expect(csv.split('\n')[0]).toContain('dimensions_not_scored')
    // Four dimensions carry zero weight in this rubric, so none is missing; the column exists
    // regardless, because an empty cell and an absent column say different things.
    expect(csv.split('\n')[1]).toContain('""')
  })

  it('GUARDS against spreadsheet formula injection in a team name', async () => {
    await query(`UPDATE submission SET team_name = '=cmd|calc' WHERE submission_id = $1`,
      [cohort.submissionIds[0]])
    const csv = await exportRanking(runId)
    expect(csv).toContain(`"'=cmd|calc"`)
  })

  it('REFUSES before a ranking exists', async () => {
    await query('DELETE FROM ranking_snapshot WHERE run_index_id = $1', [runId])
    await expect(exportRanking(runId)).rejects.toThrow(/no stored ranking/)
  })
})
