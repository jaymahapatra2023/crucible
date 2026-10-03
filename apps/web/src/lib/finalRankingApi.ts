/**
 * The final ranking of a cohort from both runs (E50).
 */
import { get, post } from './apiClient.js'

export interface FinalRankedRow {
  cohort_key: string
  submission_id: number
  challenge_id: number
  team_name: string | null
  composite_run1: number | null
  composite_run2: number | null
  composite_final: number
  single_run: boolean
  delta: number | null
  rank_global: number
  rank_in_challenge: number
  tied: boolean
  in_cut_band: boolean
  /** The runs disagree by more than the threshold, or straddle the cut line: a human looks. */
  disagreement: boolean
  partial: boolean
}

export interface FinalRanking {
  cohortKey: string
  ranked: FinalRankedRow[]
  snapshot: {
    run1_index_id: number; run2_index_id: number; weights: Record<string, number>
    cut_line_used: number; band_size_used: number; threshold_used: number
    submissions: number; computed_by: string | null; computed_at: string
  } | null
  /** A per-run ranking was recomputed after this one; recompute before trusting the order. */
  stale: boolean
  runs: { run1IndexId: number | null; run2IndexId: number | null }
}

export const getFinalRanking = (cohortKey: string) =>
  get<FinalRanking>(`/scoring/cohorts/${encodeURIComponent(cohortKey)}/final`)
export const computeFinalRanking = (cohortKey: string) =>
  post<FinalRanking>(`/scoring/cohorts/${encodeURIComponent(cohortKey)}/final`)
