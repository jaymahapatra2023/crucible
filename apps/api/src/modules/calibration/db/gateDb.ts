/**
 * SQL for gate criteria, calibration reports and decisions (E11-S02, E11-S03).
 */
import { query, queryOne } from '../../../db/pool.js'

export interface CriteriaRow {
  criteria_id: number
  golden_set_id: number
  min_rank_correlation: number
  max_material_disagreements: number
  material_rank_gap: number
  max_run_variance: number
  fallback_plan: string
  notes: string
  recorded_by: string
  recorded_at: Date
}

export async function insertCriteria(input: {
  goldenSetId: number
  minRankCorrelation: number
  maxMaterialDisagreements: number
  materialRankGap: number
  maxRunVariance: number
  fallbackPlan: string
  notes: string
  recordedBy: string
}): Promise<CriteriaRow> {
  const row = await queryOne<CriteriaRow>(
    `INSERT INTO gate_criteria
       (golden_set_id, min_rank_correlation, max_material_disagreements, material_rank_gap,
        max_run_variance, fallback_plan, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.goldenSetId, input.minRankCorrelation, input.maxMaterialDisagreements,
     input.materialRankGap, input.maxRunVariance, input.fallbackPlan,
     input.notes, input.recordedBy])
  if (!row) throw new Error('insertCriteria returned no row')
  return row
}

/**
 * The criteria in force for a golden set — the most recent, which is the only one that can
 * predate a report produced now.
 */
export async function currentCriteria(goldenSetId: number): Promise<CriteriaRow | null> {
  return queryOne<CriteriaRow>(
    `SELECT * FROM gate_criteria WHERE golden_set_id = $1
      ORDER BY recorded_at DESC, criteria_id DESC LIMIT 1`,
    [goldenSetId])
}

export async function criteriaHistory(goldenSetId: number): Promise<CriteriaRow[]> {
  const res = await query<CriteriaRow>(
    `SELECT * FROM gate_criteria WHERE golden_set_id = $1 ORDER BY recorded_at DESC`,
    [goldenSetId])
  return res.rows
}

export interface ReportRow {
  report_id: number
  golden_set_id: number
  criteria_id: number
  run_index_id: number
  second_run_index_id: number | null
  rank_correlation: number | null
  correlation_note: string | null
  sample_size: number
  material_disagreements: number
  max_run_variance: number | null
  detail: Record<string, unknown>
  generated_by: string
  generated_at: Date
}

export async function insertReport(input: {
  goldenSetId: number
  criteriaId: number
  runIndexId: number
  secondRunIndexId: number | null
  rankCorrelation: number | null
  correlationNote: string | null
  sampleSize: number
  materialDisagreements: number
  maxRunVariance: number | null
  detail: Record<string, unknown>
  generatedBy: string
}): Promise<ReportRow> {
  const row = await queryOne<ReportRow>(
    `INSERT INTO calibration_report
       (golden_set_id, criteria_id, run_index_id, second_run_index_id, rank_correlation,
        correlation_note, sample_size, material_disagreements, max_run_variance,
        detail, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`,
    [input.goldenSetId, input.criteriaId, input.runIndexId, input.secondRunIndexId,
     input.rankCorrelation, input.correlationNote, input.sampleSize,
     input.materialDisagreements, input.maxRunVariance,
     JSON.stringify(input.detail), input.generatedBy])
  if (!row) throw new Error('insertReport returned no row')
  return row
}

export async function selectReport(reportId: number): Promise<ReportRow | null> {
  return queryOne<ReportRow>(
    'SELECT * FROM calibration_report WHERE report_id = $1', [reportId])
}

export interface DecisionRow {
  decision_id: number
  report_id: number
  decision: string
  rationale: string
  decided_by: string
  decided_at: Date
  /** The configuration this verdict was measured under (E14-S03). */
  pinned_config?: Record<string, unknown>
}

export async function insertDecision(input: {
  reportId: number; decision: string; rationale: string; decidedBy: string
  pinnedConfig?: unknown
}): Promise<DecisionRow> {
  const row = await queryOne<DecisionRow>(
    `INSERT INTO gate_decision (report_id, decision, rationale, decided_by, pinned_config)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
    [input.reportId, input.decision, input.rationale, input.decidedBy,
     JSON.stringify(input.pinnedConfig ?? {})])
  if (!row) throw new Error('insertDecision returned no row')
  return row
}

export interface GateStatusRow {
  decision_id: number
  decision: string
  rationale: string
  decided_by: string
  decided_at: Date
  report_id: number
  golden_set_id: number
  rank_correlation: number | null
  criteria_id: number
  fallback_plan: string
  /** The settings this verdict was measured under (E14-S03). */
  pinned_config?: Record<string, unknown>
}

/**
 * The gate's current position — the most recent decision, whatever it was.
 *
 * Null means no decision has been taken. That is NOT the same as GO, and the caller must not
 * treat it as one: an uncalibrated system is exactly what E11-S03 exists to prevent being used
 * by default.
 */
export async function latestGateDecision(): Promise<GateStatusRow | null> {
  return queryOne<GateStatusRow>('SELECT * FROM v_gate_status LIMIT 1')
}
