/** Review and shortlist API surface (E08). */
import { get, post } from './apiClient.js'

export interface DimensionCell {
  dimension: string
  score: number | null
  dataQuality: 'COMPLETE' | 'PARTIAL' | 'UNSCORED'
  weight: number
}

export interface ReviewRow {
  submission_id: number
  challenge_id: number
  team_name: string | null
  composite: number
  rank_global: number
  rank_in_challenge: number
  tied: boolean
  partial: boolean
  in_cut_band: boolean
  advisory_decided: boolean
  requires_review: boolean
  weight_covered: number
  missing_dimensions: string[]
  normalisation_method: string
  open_flags: number
  dismissed_flags: number
  decision: string | null
  decision_reason: string | null
  dimensions: DimensionCell[]
}

export interface ReviewTable {
  rows: ReviewRow[]
  /** Matching the filter across the whole field — never the length of `rows`. */
  total: number
  totalUnfiltered: number
  limit: number
  offset: number
  sort: string
  counts: {
    inCutBand: number
    requiresReview: number
    withOpenFlags: number
    decided: number
  }
}

export interface ReviewFlag {
  submission_id: number
  code: string
  severity: 'ADVISORY' | 'ATTENTION'
  message: string
  detail: Record<string, unknown>
  dismissed: boolean
  dismissed_by: string | null
  dismissal_reason: string | null
}

export interface RunDifference {
  criterionId: number
  dimension: string
  runA: { runIndex: number; rawScore: number | null; nonScore: string | null; rationale: string }
  runB: { runIndex: number; rawScore: number | null; nonScore: string | null; rationale: string }
}

export interface TeamDetail {
  /** Where they sat and who coached them. Null where the roster never placed them. */
  place: { teamId: number; roomLabel: string | null; coachName: string | null } | null
  submission: {
    submission_id: number
    team_name: string
    team_id: number | null
    challenge_id: number
    repo_url: string
    build_method: string
    locked_commit_sha: string | null
  } | null
  ranking: ReviewRow | null
  dimensions: Array<{
    dimension: string
    score: number | null
    data_quality: string
    weight: number
    scored_count: number
    total_count: number
  }>
  criteria: Array<{
    id: number
    criterion_id: number
    dimension: string
    raw_score: number | null
    non_score: string | null
    confidence: number
    rationale: string
    anchor_matched: string | null
    evidence: Array<{
      path: string; lineStart: number; lineEnd: number; excerpt: string
      /** The verdict of checking this citation against the scan (E13). Absent on older scores. */
      verdict?: 'VERIFIED' | 'RELOCATED' | 'UNVERIFIABLE' | 'CONTRADICTED'
      verdictReason?: string
    }>
    context_bytes: number
    context_truncated: boolean
    files_searched: number
    rubric_version: number
    model: string | null
  }>
  flags: ReviewFlag[]
  decision: ShortlistDecision | null
  probe: {
    probe_id: number
    outcome: string
    runs_grade: string
    grade_reason: string
    log_truncated: boolean
  } | null
  provenance: Array<{ code: string; message: string }>
  runDifferences: RunDifference[]
}

export interface ShortlistDecision {
  submission_id: number
  decision: 'SHORTLIST' | 'EXCLUDE' | 'HOLD'
  reason: string
  decided_by: string
  decided_at: string
  rank_at_decision: number | null
}

export interface ShortlistState {
  shortlist: {
    shortlist_id: number
    status: 'OPEN' | 'FINAL'
    name: string
    finalised_by: string | null
    finalised_at: string | null
    rubric_versions: Record<string, number>
  }
  decisions: ShortlistDecision[]
  counts: Record<string, number>
  /** Cut-band submissions with no decision or on hold — these block finalising. */
  blocking: Array<{ submission_id: number; rank_global: number; state: string }>
}

export interface TableFilter {
  challengeId?: number
  flagCode?: string
  flaggedOnly?: boolean
  bandOnly?: boolean
  decision?: string
  missingDimension?: string
  sort?: string
  limit?: number
  offset?: number
}

export interface ScoringRun {
  run_index_id: number
  run_index: number
  cohort_key: string
  status: string
  started_at: string
  finished_at: string | null
  submissions: number
  ranked: number
  shortlist_status: string | null
}

function queryString(filter: TableFilter): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '' && value !== false) params.set(key, String(value))
  }
  const q = params.toString()
  return q ? `?${q}` : ''
}

export const getScoringRuns = () => get<ScoringRun[]>('/scoring/runs')

export const getReviewTable = (runId: number, filter: TableFilter = {}) =>
  get<ReviewTable>(`/review/runs/${runId}/table${queryString(filter)}`)

export const getTeamDetail = (runId: number, submissionId: number) =>
  get<TeamDetail>(`/review/runs/${runId}/teams/${submissionId}`)

export const getShortlist = (runId: number) =>
  get<ShortlistState>(`/review/runs/${runId}/shortlist`)

export const dismissReviewFlag = (
  runId: number, submissionId: number, code: string, reason: string,
) => post<ReviewFlag>(`/review/runs/${runId}/flags/dismiss`, { submissionId, code, reason })

export const recordDecision = (
  runId: number, submissionId: number,
  decision: 'SHORTLIST' | 'EXCLUDE' | 'HOLD', reason: string,
) => post<ShortlistDecision>(`/review/runs/${runId}/decisions`, { submissionId, decision, reason })

export const finaliseShortlist = (runId: number) =>
  post<ShortlistState['shortlist']>(`/review/runs/${runId}/finalise`)

/**
 * One earlier decision about a team (E23).
 *
 * `superseded_at` is null on the one that stands. A move keeps what it moved from, because the
 * question an appeal asks is who decided what, in what order, and why.
 */
export interface DecisionHistoryEntry {
  id: number
  decision: 'SHORTLIST' | 'EXCLUDE' | 'HOLD'
  reason: string
  decided_by: string
  decided_at: string
  rank_at_decision: number | null
  superseded_at: string | null
}

export const getDecisionHistory = (runIndexId: number, submissionId: number) =>
  get<DecisionHistoryEntry[]>(
    `/review/runs/${runIndexId}/decisions/${submissionId}/history`)
