/** Calibration and go/no-go gate API surface (E11). */
import { get, post } from './apiClient.js'

export interface GateStatus {
  decision_id: number
  decision: 'GO' | 'NO_GO'
  rationale: string
  decided_by: string
  decided_at: string
  report_id: number
  golden_set_id: number
  rank_correlation: number | null
  fallback_plan: string
  /**
   * Whether the settings now in force are the ones this verdict was measured under (E14-S03).
   *
   * A gate vouches for a configuration, not for all time. Reading a passed gate as blanket
   * permission after the cut line moved is the mistake this exists to prevent.
   */
  coversCurrentConfig?: boolean | null
  configNote?: string
}

export interface GateResponse {
  status: GateStatus | null
  rankingPermitted: boolean
  /** Set when no decision exists — the state most easily mistaken for a pass. */
  note: string | null
}

export interface GoldenSetSummary {
  golden_set_id: number
  name: string
  description: string
  status: 'OPEN' | 'SEALED'
  sealed_at: string | null
  sealed_by: string | null
}

export interface Readiness {
  canSeal: boolean
  entries: number
  rankers: string[]
  incompleteRankers: string[]
  missingEdgeCases: string[]
  missingBands: string[]
  problems: string[]
  /** Worth knowing before an irreversible seal, but not grounds to refuse it. */
  warnings: string[]
  agreement: RaterAgreement | null
}

export const getGate = () => get<GateResponse>('/calibration/gate')
export const getGoldenSets = () => get<GoldenSetSummary[]>('/calibration/sets')

// ── The calibration workflow (E18-S02 … S04) ──────────────────────────────────────────────
//
// All of this existed as API and nowhere else, which made the most consequential decision in
// the system — whether it is fit to eliminate anyone — the least accessible. A gate that can
// only be exercised through curl is a gate that gets skipped when the evening is tight.

export const EXPECTED_BANDS = ['STRONG', 'MIDDLING', 'WEAK'] as const
export const EDGE_CASES = [
  'SCAFFOLD_ONLY', 'WRONG_PROBLEM', 'FAILS_TO_BUILD', 'VERY_LARGE',
] as const

export interface GoldenEntry {
  entry_id: number
  label: string
  repo_url: string
  expected_band: (typeof EXPECTED_BANDS)[number]
  edge_case: (typeof EDGE_CASES)[number] | null
  notes: string
}

export interface GoldenSetDetail {
  set: GoldenSetSummary
  entries: GoldenEntry[]
  readiness: Readiness
}

export interface RankingRow {
  entry_id: number
  ranker: string
  position: number
  rationale: string | null
}

/** How much the human rankers agreed with EACH OTHER — the denominator ρ is read against. */
export interface RaterAgreement {
  rankers: string[]
  pairs: Array<{ a: string; b: string; rho: number | null; n: number }>
  lowest: number | null
  mean: number | null
  strength: 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG'
  /** Agreement too close to take at face value — a question about independence, not a finding. */
  independenceQuestioned: boolean
  note: string
}

export interface CalibrationReport {
  report_id: number
  golden_set_id: number
  rank_correlation: number | null
  /** Carries the ranker-agreement caveat when there is one, so the number is never read alone. */
  correlation_note: string | null
  detail?: { interRater?: RaterAgreement }
  sample_size: number
  material_disagreements: number
  disagreements: Array<{
    entryId: number; label: string; handPosition: number
    machinePosition: number; gap: number; evidence: string
  }>
  dimension_agreement: Record<string, number>
  run_variance: number | null
  generated_at: string
}

export interface GateCriteria {
  criteria_id: number
  min_rank_correlation: number
  max_material_disagreements: number
  material_rank_gap: number
  max_run_variance: number
  fallback_plan: string
  notes: string
  recorded_by: string
  recorded_at: string
}

export const createGoldenSet = (name: string, description: string) =>
  post<GoldenSetSummary>('/calibration/sets', { name, description })

export const getGoldenSet = (id: number) => get<GoldenSetDetail>(`/calibration/sets/${id}`)

export const addGoldenEntry = (id: number, entry: {
  label: string; repoUrl: string
  expectedBand: (typeof EXPECTED_BANDS)[number]
  edgeCase: (typeof EDGE_CASES)[number] | null
  notes: string
}) => post<GoldenEntry>(`/calibration/sets/${id}/entries`, entry)

// ── Linking entries to the submissions the machine scored (E21) ───────────────────────────

export const LINK_OUTCOMES = [
  'MATCHED', 'ALREADY_LINKED', 'NO_SUBMISSION', 'AMBIGUOUS', 'UNREADABLE',
] as const
export type LinkOutcome = (typeof LINK_OUTCOMES)[number]

export interface LinkRow {
  entryId: number
  label: string
  repoUrl: string
  expectedBand: string
  edgeCase: string | null
  submissionId: number | null
  teamName: string | null
  outcome: LinkOutcome
  detail: string | null
}

export interface LinkPlan {
  rows: LinkRow[]
  summary: { total: number; resolved: number; unresolved: number }
  linked: boolean
  refusal: string | null
}

/**
 * Ask what linking would do (`confirm: false`), or do it (`confirm: true`).
 *
 * Without this no report can be produced at all: the report needs a machine ordering to compare
 * the hand ranking against, and that comes from the submission behind each entry.
 */
export const linkGoldenSet = (id: number, confirm: boolean) =>
  post<LinkPlan>(`/calibration/sets/${id}/link`, { confirm })

export const sealGoldenSet = (id: number) =>
  post<GoldenSetSummary>(`/calibration/sets/${id}/seal`, {})

export const recordRanking = (id: number, ranker: string, positions: Array<{
  entryId: number; position: number; rationale?: string
}>) => post<{ recorded: number }>(`/calibration/sets/${id}/rankings`, { ranker, positions })

export const getRankings = (id: number) =>
  get<{ sealed: boolean; rankings: RankingRow[] }>(`/calibration/sets/${id}/rankings`)

/**
 * The criteria in force, and the ones that preceded them.
 *
 * The endpoint returns `{ current, history }` — criteria are append-only (P7.1), so superseded
 * ones are kept rather than overwritten. Unwrapped here so callers deal in the current set.
 */
export const getGateCriteria = (id: number) =>
  get<{ current: GateCriteria | null; history: GateCriteria[] }>(
    `/calibration/sets/${id}/criteria`).then((r) => r.current)

export const recordGateCriteria = (id: number, criteria: {
  minRankCorrelation: number; maxMaterialDisagreements: number
  materialRankGap: number; maxRunVariance: number
  fallbackPlan: string; notes: string
}) => post<GateCriteria>(`/calibration/sets/${id}/criteria`, criteria)

export const generateReport = (id: number, runIndexId: number) =>
  post<CalibrationReport>(`/calibration/sets/${id}/report`, { runIndexId })

export const recordDecision = (reportId: number, decision: 'GO' | 'NO_GO', rationale: string) =>
  post<{ decision_id: number }>(`/calibration/reports/${reportId}/decision`, {
    decision, rationale,
  })
