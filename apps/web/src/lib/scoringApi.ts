/** Scoring API surface (E06-S02 … E06-S06). */
import { get, post } from './apiClient.js'

/** How much of a ranked field was described by discovery before it was scored (E15-S04). */
export interface DiscoveryCoverage {
  submissions: number
  discovered: number
  completed: number
  undiscovered: number
  state: 'NONE' | 'PARTIAL' | 'COMPLETE'
  /** True only when some were described and some were not — the one unfair state. */
  uneven: boolean
  note: string
}

export interface EvidenceItem {
  path: string
  lineStart: number
  lineEnd: number
  excerpt: string
  /**
   * Whether this quotation was found in the commit that was scanned (E13).
   *
   * Optional because scores taken before citation checking carry none, and showing "checked"
   * for those would be a claim we cannot support.
   */
  verdict?: 'VERIFIED' | 'RELOCATED' | 'UNVERIFIABLE' | 'CONTRADICTED'
  verdictReason?: string
}

export interface CriterionScore {
  id: number
  criterion_id: number
  dimension: string
  raw_score: number | null
  non_score: string | null
  confidence: number
  rationale: string
  anchor_matched: string | null
  evidence: EvidenceItem[]
  context_bytes: number
  context_truncated: boolean
  files_searched: number
  rubric_version: number
  model: string | null
}

export interface PrincipleAssessment {
  principle_id: number
  code: string
  name: string
  maturity: number | null
  non_score: string | null
  confidence: number
  rationale: string
  evidence: EvidenceItem[]
}

export interface StandardAssessment {
  standard_id: number
  code: string
  name: string
  compliance: string | null
  non_score: string | null
  confidence: number
  rationale: string
  evidence: EvidenceItem[]
}

export interface OriginalityAssessment {
  level: number | null
  non_score: string | null
  confidence: number
  rationale: string
  observations: string[]
  /** A percentage with one decimal place, as a number. */
  boilerplate_share_pct: number
  scaffold_lines: number
  substantive_lines: number
  templates: Array<{ id: string; name: string; matchedOn: string }>
  provenance_flags: Array<{ code: string; message: string }>
}

/** The measurements the engineering score was computed from (E06-S04 acceptance 3). */
export interface MetricInputs {
  summary: string
  metrics: Record<string, unknown>
  filesAnalysed: number
  filesTotal: number
  budgetTruncated: boolean
  commitSha: string | null
}

export interface SubmissionScores {
  criteria: CriterionScore[]
  principles: PrincipleAssessment[]
  standards: StandardAssessment[]
  originality: OriginalityAssessment | null
  metrics: MetricInputs | null
}

/** A stored ranking row, as the published view serves it. */
export interface RankedSubmission {
  submission_id: number
  challenge_id: number
  team_name: string | null
  composite: number
  fidelity_raw: number | null
  fidelity_normalised: number | null
  cohort_size: number
  normalisation_method: string
  missing_dimensions: string[]
  weight_covered: number
  partial: boolean
  rank_global: number
  rank_in_challenge: number
  tied: boolean
  in_cut_band: boolean
  advisory_decided: boolean
  requires_review: boolean
  review_reasons: string[]
  /** The same reasons in plain language, worded by the API so there is one vocabulary. */
  review_reason_text: string[]
}

export interface RankingSnapshot {
  scores_counted: number
  submissions: number
  cut_line_used: number
  band_size_used: number
  min_cohort_size: number
  computed_by: string | null
  computed_at: string
}

export interface Ranking {
  ranked: RankedSubmission[]
  snapshot: RankingSnapshot | null
  /** True when scores were added after this ranking was computed. */
  stale: boolean
  fallbackChallenges: number[]
  partialCount: number
  cutLine: number
  bandSize: number
  /** Whether this field was evidenced evenly (E15-S04). Absent on rankings computed before it. */
  discoveryCoverage?: DiscoveryCoverage
}

export interface ChallengeSplit {
  challengeId: number
  inShortlist: number
  shareOfShortlistPct: number
  ranked: number
  cohortSize: number
  belowFloor: boolean
  medianComposite: number | null
  medianShortlisted: number | null
  bestRank: number | null
}

export interface SplitReport {
  shortlistSize: number
  shortlisted: number
  byChallenge: ChallengeSplit[]
  /** Non-blocking; null when the split is within tolerance. */
  advisory: string | null
  imbalanceThresholdPct: number
}

export interface CutBandReport {
  cutLine: number
  bandSize: number
  band: RankedSubmission[]
  advisoryDecided: RankedSubmission[]
  tiedAtCut: RankedSubmission[]
  /** Flagged for review anywhere in the order, not only within the band. */
  requiresReview: RankedSubmission[]
}

export interface VarianceFlag {
  submission_id: number
  composite_a: number
  composite_b: number
  delta: number
  rank_a: number
  rank_b: number
  straddles_cut: boolean
  exceeds_threshold: boolean
  threshold_used: number
  cut_line_used: number
  dismissed: boolean
  dismissal_reason: string | null
}

export const getSubmissionScores = (runIndexId: number, submissionId: number) =>
  get<SubmissionScores>(`/scoring/runs/${runIndexId}/scores?submissionId=${submissionId}`)

export const getRanking = (runIndexId: number) =>
  get<Ranking>(`/scoring/runs/${runIndexId}/ranking`)

export const getBorderline = (runIndexId: number) =>
  get<CutBandReport>(`/scoring/runs/${runIndexId}/borderline`)

export const getSplit = (runIndexId: number) =>
  get<SplitReport>(`/scoring/runs/${runIndexId}/split`)

export const getVariance = (cohortKey: string) =>
  get<{ all: VarianceFlag[]; open: VarianceFlag[]; openCount: number }>(
    `/scoring/cohorts/${encodeURIComponent(cohortKey)}/variance`)

export const dismissVarianceFlag = (cohortKey: string, submissionId: number, reason: string) =>
  post<VarianceFlag>(
    `/scoring/cohorts/${encodeURIComponent(cohortKey)}/variance/dismiss`,
    { submissionId, reason })
