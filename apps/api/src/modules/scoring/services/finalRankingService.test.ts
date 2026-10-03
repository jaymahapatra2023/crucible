/**
 * Combining two runs into one list (E50). Pure: no database.
 */
import { describe, expect, it } from 'vitest'
import { mergeRuns } from './finalRankingService.js'
import type { CompositeRow } from '../db/rankingDb.js'

const row = (submissionId: number, composite: number, rankGlobal: number, over: Partial<CompositeRow> = {}): CompositeRow => ({
  run_index_id: 1, submission_id: submissionId, challenge_id: 1, team_name: `Team ${submissionId}`,
  composite, fidelity_raw: 70, fidelity_normalised: 80, cohort_size: 10, normalisation_method: 'PERCENTILE',
  rank_global: rankGlobal, rank_in_challenge: rankGlobal, tied: false, weight_covered: 1,
  missing_dimensions: [], partial: false, in_cut_band: false, advisory_decided: false,
  requires_review: false, review_reasons: [], computed_at: new Date(), ...over,
})

const base = { weights: { 1: 0.5, 2: 0.5 } as const, cutLine: 2, bandSize: 1, deltaThreshold: 10 }

describe('mergeRuns', () => {
  it('ranks by the weighted mean of both runs, keeping both composites beside it', () => {
    const out = mergeRuns({ ...base,
      run1: [row(1, 80, 1), row(2, 60, 2)],
      run2: [row(1, 70, 2, { run_index_id: 2 }), row(2, 90, 1, { run_index_id: 2 })],
    })
    expect(out.map((r) => [r.submission_id, r.composite_final, r.rank_global])).toEqual([[1, 75, 1], [2, 75, 2]])
    expect(out[0]).toMatchObject({ composite_run1: 80, composite_run2: 70, delta: 10, tied: true })
  })

  it('honours unequal weights', () => {
    const out = mergeRuns({ ...base, weights: { 1: 0.25, 2: 0.75 },
      run1: [row(1, 80, 1)], run2: [row(1, 40, 1, { run_index_id: 2 })] })
    expect(out[0]!.composite_final).toBe(50)
  })

  it('marks disagreement when the runs differ by more than the threshold', () => {
    const out = mergeRuns({ ...base,
      run1: [row(1, 90, 1), row(2, 50, 2)], run2: [row(1, 70, 1, { run_index_id: 2 }), row(2, 50, 2, { run_index_id: 2 })] })
    expect(out.find((r) => r.submission_id === 1)!.disagreement).toBe(true)
    expect(out.find((r) => r.submission_id === 2)!.disagreement).toBe(false)
  })

  it('marks disagreement when the runs straddle the cut line, even with a small delta', () => {
    // Three teams, cut at 2: run 1 puts #3 inside, run 2 puts it outside, on a 2-point delta.
    const out = mergeRuns({ ...base,
      run1: [row(1, 90, 1), row(3, 71, 2), row(2, 70, 3)],
      run2: [row(1, 90, 1, { run_index_id: 2 }), row(2, 72, 2, { run_index_id: 2 }), row(3, 69, 3, { run_index_id: 2 })] })
    expect(out.find((r) => r.submission_id === 3)!.disagreement).toBe(true)
  })

  it('keeps a submission scored in one run only, at that composite, and says so', () => {
    const out = mergeRuns({ ...base, run1: [row(1, 80, 1), row(2, 60, 2)], run2: [row(1, 80, 1, { run_index_id: 2 })] })
    const only = out.find((r) => r.submission_id === 2)!
    expect(only).toMatchObject({ composite_final: 60, single_run: true, composite_run2: null, delta: null, disagreement: false })
  })

  it('marks the cut band from the FINAL rank', () => {
    const out = mergeRuns({ ...base, cutLine: 2, bandSize: 1,
      run1: [row(1, 90, 1), row(2, 80, 2), row(3, 70, 3), row(4, 10, 4)],
      run2: [row(1, 90, 1, { run_index_id: 2 }), row(2, 80, 2, { run_index_id: 2 }), row(3, 70, 3, { run_index_id: 2 }), row(4, 10, 4, { run_index_id: 2 })] })
    expect(out.filter((r) => r.in_cut_band).map((r) => r.rank_global)).toEqual([1, 2, 3])
    expect(out.find((r) => r.submission_id === 4)!.in_cut_band).toBe(false)
  })
})
