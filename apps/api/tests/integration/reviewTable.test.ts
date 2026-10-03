/**
 * The ranked review table and team detail (E08-S01, E08-S02, E08-S06).
 *
 * The property most worth protecting here is data honesty. A reviewer works through this table
 * and draws conclusions from what it says; a count that describes the fetched page rather than
 * the field is the most convincing lie this system could tell, because it is only wrong when the
 * page boundary is crossed — which is rarely, and never during testing unless it is tested for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { reviewTable } from '../../src/modules/review/services/reviewTable.js'
import { teamDetail } from '../../src/modules/review/services/teamDetail.js'
import { openShortlist, decide } from '../../src/modules/review/services/shortlistService.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, insufficientTurn, originalityTurn, scoreTurn, seedCohort,
  type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
let other: CohortFixture
let cohortKey: string
let runId: number

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  cohortKey = `tbl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  cohort = await seedCohort({ count: 3 })
  other = await seedCohort({ count: 2, name: 'Second challenge' })

  provider.setScript([
    scoreTurn(4), originalityTurn(3),
    scoreTurn(3), originalityTurn(3),
    insufficientTurn(), originalityTurn(3),
    scoreTurn(2), originalityTurn(3),
    scoreTurn(1), originalityTurn(3),
  ])
  const outcome = await inScope(() => startRun({
    cohortKey, runIndex: 1,
    submissionIds: [...cohort.submissionIds, ...other.submissionIds], startedBy: ACTOR,
  }))
  runId = outcome.run.run_index_id
  await computeRanking(runId, ACTOR)
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('the ranked table (E08-S01)', () => {
  it('carries rank, team, challenge, composite, breakdown and flags in one row', async () => {
    const { rows } = await reviewTable({ runIndexId: runId })
    const top = rows[0]!

    expect(top.rank_global).toBe(1)
    expect(top.team_name).toBeTruthy()
    expect(top.challenge_id).toBeTruthy()
    expect(Number(top.composite)).toBeGreaterThan(0)
    // The dimension breakdown, so a reviewer sees where the score came from without opening it.
    expect(top.dimensions.length).toBeGreaterThan(0)
    expect(top.open_flags).toBeGreaterThan(0)
  })

  it('carries the WEIGHT each dimension held, not just its score', async () => {
    const { rows } = await reviewTable({ runIndexId: runId })
    const fidelity = rows[0]!.dimensions.find((d) => d.dimension === 'CHALLENGE_FIDELITY')
    // A 30-point dimension at 5% weight is a different story from the same number at 30%.
    expect(Number(fidelity?.weight)).toBe(1)
  })

  it('reports an unscoreable dimension as UNSCORED, never as zero', async () => {
    const { rows } = await reviewTable({ runIndexId: runId })
    const runs = rows[0]!.dimensions.find((d) => d.dimension === 'RUNS')
    expect(runs?.dataQuality).toBe('UNSCORED')
    expect(runs?.score).toBeNull()
  })

  it('orders by rank', async () => {
    const { rows } = await reviewTable({ runIndexId: runId })
    expect(rows.map((r) => r.rank_global)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('filtering happens in the database (E08-S01 acceptance 2)', () => {
  it('filters by challenge', async () => {
    const table = await reviewTable({
      runIndexId: runId, filter: { challengeId: cohort.challengeId },
    })
    expect(table.total).toBe(3)
    expect(table.rows.every((r) => r.challenge_id === cohort.challengeId)).toBe(true)
  })

  it('filters by a specific flag code', async () => {
    const table = await reviewTable({
      runIndexId: runId, filter: { flagCode: 'INSUFFICIENT_EVIDENCE' },
    })
    expect(table.total).toBe(1)
  })

  it('filters to submissions missing a given dimension', async () => {
    const table = await reviewTable({
      runIndexId: runId, filter: { missingDimension: 'CHALLENGE_FIDELITY' },
    })
    // One submission's only criterion could not be evidenced, so its fidelity is unscored.
    expect(table.total).toBe(1)
  })

  it('does not call a ZERO-WEIGHT dimension missing', async () => {
    // Nothing was probed, so Runs has no score — but this rubric gives Runs no weight, so it
    // never entered the composite. "Not part of the score" and "should have been and was not"
    // are different states, and only the second is a gap.
    const table = await reviewTable({
      runIndexId: runId, filter: { missingDimension: 'RUNS' },
    })
    expect(table.total).toBe(0)
  })

  it('filters to the cut band', async () => {
    const table = await reviewTable({ runIndexId: runId, filter: { bandOnly: true } })
    expect(table.rows.every((r) => r.in_cut_band)).toBe(true)
  })

  it('binds filter values rather than interpolating them', async () => {
    // A filter that concatenated its input would be an injection point on the screen that
    // decides who presents. This returns nothing rather than executing anything.
    const table = await reviewTable({
      runIndexId: runId, filter: { flagCode: "x' OR '1'='1" },
    })
    expect(table.total).toBe(0)
  })
})

describe('sorting (E08-S01 acceptance 2)', () => {
  it('orders by rank by default', async () => {
    const { rows, sort } = await reviewTable({ runIndexId: runId })
    expect(sort).toBe('rank')
    expect(rows.map((r) => r.rank_global)).toEqual([1, 2, 3, 4, 5])
  })

  it('orders by a dimension score, highest first', async () => {
    const { rows } = await reviewTable({ runIndexId: runId, sort: 'CHALLENGE_FIDELITY' })
    const scored = rows
      .map((r) => r.dimensions.find((d) => d.dimension === 'CHALLENGE_FIDELITY')?.score)
      .filter((s): s is number => s !== null && s !== undefined)
      .map(Number)
    expect([...scored].sort((a, b) => b - a)).toEqual(scored)
  })

  it('puts an UNSCORED dimension last, never first as if it were zero', async () => {
    const { rows } = await reviewTable({ runIndexId: runId, sort: 'CHALLENGE_FIDELITY' })
    const unscored = rows.findIndex((r) =>
      r.dimensions.find((d) => d.dimension === 'CHALLENGE_FIDELITY')?.score === null)
    // The submission whose only criterion could not be evidenced sorts to the bottom.
    expect(unscored).toBe(rows.length - 1)
  })

  it('orders by open caveat count', async () => {
    const { rows } = await reviewTable({ runIndexId: runId, sort: 'flags' })
    const counts = rows.map((r) => r.open_flags)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('IGNORES a sort key that is not on the allow-list', async () => {
    // Never interpolated: an unknown key falls back to rank rather than reaching SQL.
    const { rows } = await reviewTable({
      runIndexId: runId, sort: 'composite; DROP TABLE submission_composite',
    })
    expect(rows.map((r) => r.rank_global)).toEqual([1, 2, 3, 4, 5])
    const still = await query('SELECT 1 FROM submission_composite LIMIT 1')
    expect(still.rows).toHaveLength(1)
  })
})

describe('data honesty (E08-S06 acceptance 1)', () => {
  it('counts the whole FILTERED set, not the page that was fetched', async () => {
    const page = await reviewTable({ runIndexId: runId, limit: 2 })
    expect(page.rows).toHaveLength(2)
    // The count that matters: five match, two were returned.
    expect(page.total).toBe(5)
    expect(page.totalUnfiltered).toBe(5)
  })

  it('reports the filtered total AND the unfiltered one, so "X of Y" is truthful', async () => {
    const table = await reviewTable({
      runIndexId: runId, filter: { challengeId: other.challengeId }, limit: 1,
    })
    expect(table.rows).toHaveLength(1)
    expect(table.total).toBe(2)
    expect(table.totalUnfiltered).toBe(5)
  })

  it('computes its summary counts in the database', async () => {
    const table = await reviewTable({ runIndexId: runId, limit: 1 })
    // Counted over the run, not over the single row returned.
    expect(table.counts.withOpenFlags).toBe(5)
    expect(table.counts.decided).toBe(0)
  })

  it('counts decisions as they are recorded', async () => {
    await openShortlist(runId, ACTOR)
    await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'SHORTLIST', reason: 'Clear leader on the evidence available.', actor: ACTOR,
    })
    expect((await reviewTable({ runIndexId: runId })).counts.decided).toBe(1)
  })

  it('REFUSES before a ranking exists rather than returning an empty table', async () => {
    await query('DELETE FROM ranking_snapshot WHERE run_index_id = $1', [runId])
    // An empty table reads as "nobody scored", which is a different and much worse claim.
    await expect(reviewTable({ runIndexId: runId })).rejects.toThrow(/no stored ranking/)
  })
})

describe('team detail (E08-S02)', () => {
  it('carries the criteria, their evidence and the repository link', async () => {
    const detail = await teamDetail(runId, cohort.submissionIds[0]!)

    expect(detail.submission?.repo_url).toMatch(/^https:\/\/github\.com/)
    expect(detail.criteria[0]?.rationale).toBeTruthy()
    expect(detail.criteria[0]?.evidence[0]?.path).toBe('src/retry.ts')
    expect(detail.criteria[0]?.anchor_matched).toBeTruthy()
  })

  it('carries the dimension breakdown and the flags', async () => {
    const detail = await teamDetail(runId, cohort.submissionIds[0]!)
    expect(detail.dimensions.length).toBeGreaterThan(0)
    expect(detail.flags.length).toBeGreaterThan(0)
  })

  it('reports no run differences when there is only one run', async () => {
    const detail = await teamDetail(runId, cohort.submissionIds[0]!)
    expect(detail.runDifferences).toEqual([])
  })

  it('shows ONLY the criteria the two runs scored differently (acceptance 5)', async () => {
    provider.setScript([
      scoreTurn(1), originalityTurn(3),
      scoreTurn(3), originalityTurn(3),
      insufficientTurn(), originalityTurn(3),
      scoreTurn(2), originalityTurn(3),
      scoreTurn(1), originalityTurn(3),
    ])
    await inScope(() => startRun({
      cohortKey, runIndex: 2,
      submissionIds: [...cohort.submissionIds, ...other.submissionIds], startedBy: ACTOR,
    }))

    const changed = await teamDetail(runId, cohort.submissionIds[0]!)
    const unchanged = await teamDetail(runId, cohort.submissionIds[1]!)

    // The first team scored 4 then 1; the second scored 3 both times.
    expect(changed.runDifferences).toHaveLength(1)
    expect(changed.runDifferences[0]?.runA.rawScore).toBe(4)
    expect(changed.runDifferences[0]?.runB.rawScore).toBe(1)
    expect(unchanged.runDifferences).toEqual([])
  })

  it('treats a score-versus-non-score as a difference', async () => {
    provider.setScript([
      scoreTurn(4), originalityTurn(3),
      insufficientTurn(), originalityTurn(3),
      scoreTurn(2), originalityTurn(3),
      scoreTurn(2), originalityTurn(3),
      scoreTurn(1), originalityTurn(3),
    ])
    await inScope(() => startRun({
      cohortKey, runIndex: 2,
      submissionIds: [...cohort.submissionIds, ...other.submissionIds], startedBy: ACTOR,
    }))

    // "Scored 3" versus "could not be evidenced" is a disagreement about the work, even
    // though neither run produced a comparable number.
    const detail = await teamDetail(runId, cohort.submissionIds[1]!)
    expect(detail.runDifferences).toHaveLength(1)
    expect(detail.runDifferences[0]?.runB.nonScore).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('404s a run that does not exist', async () => {
    await expect(teamDetail(999999, cohort.submissionIds[0]!)).rejects.toThrow(/not found/)
  })
})
