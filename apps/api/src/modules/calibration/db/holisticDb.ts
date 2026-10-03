/**
 * SQL for the holistic-evaluation experiment (migration 092).
 *
 * Deliberately isolated: nothing here writes to `criterion_score`, a composite or a ranking, so
 * the experiment cannot contribute to a decision about a team however it turns out.
 */
import { query, queryOne } from '../../../db/pool.js'

export interface HolisticRow {
  evaluation_id: number
  submission_id: number
  golden_set_id: number | null
  pass_index: number
  model: string
  overall: number | null
  non_score: string | null
  verdict: string
  reasoning: string
  strengths: string[]
  weaknesses: string[]
  evidence: Array<{ path: string; why: string }>
  confidence: number | null
  injection_noted: string | null
  context_bytes: number
  files_shown: number
  files_in_scan: number
  context_truncated: boolean
  cost_usd: string
  evaluated_by: string
}

const COLS = `evaluation_id, submission_id, golden_set_id, pass_index, model, overall, non_score,
              verdict, reasoning, strengths, weaknesses, evidence, confidence, injection_noted,
              context_bytes, files_shown, files_in_scan, context_truncated, cost_usd, evaluated_by`

export async function upsertHolistic(input: Omit<HolisticRow, 'evaluation_id' | 'cost_usd'> & {
  costUsd: number
}): Promise<HolisticRow> {
  const row = await queryOne<HolisticRow>(
    `INSERT INTO holistic_evaluation
       (submission_id, golden_set_id, pass_index, model, overall, non_score, verdict, reasoning,
        strengths, weaknesses, evidence, confidence, injection_noted, context_bytes, files_shown,
        files_in_scan, context_truncated, cost_usd, evaluated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (submission_id, pass_index) DO UPDATE SET
       model = EXCLUDED.model, overall = EXCLUDED.overall, non_score = EXCLUDED.non_score,
       verdict = EXCLUDED.verdict, reasoning = EXCLUDED.reasoning, strengths = EXCLUDED.strengths,
       weaknesses = EXCLUDED.weaknesses, evidence = EXCLUDED.evidence,
       confidence = EXCLUDED.confidence, injection_noted = EXCLUDED.injection_noted,
       context_bytes = EXCLUDED.context_bytes, files_shown = EXCLUDED.files_shown,
       files_in_scan = EXCLUDED.files_in_scan, context_truncated = EXCLUDED.context_truncated,
       cost_usd = EXCLUDED.cost_usd, evaluated_by = EXCLUDED.evaluated_by, evaluated_at = now()
     RETURNING ${COLS}`,
    [input.submission_id, input.golden_set_id, input.pass_index, input.model, input.overall,
     input.non_score, input.verdict, input.reasoning, JSON.stringify(input.strengths),
     JSON.stringify(input.weaknesses), JSON.stringify(input.evidence), input.confidence,
     input.injection_noted, input.context_bytes, input.files_shown, input.files_in_scan,
     input.context_truncated, input.costUsd, input.evaluated_by])
  if (!row) throw new Error('upsertHolistic returned no row')
  return row
}

export async function selectHolistic(goldenSetId: number, passIndex: number): Promise<HolisticRow[]> {
  const res = await query<HolisticRow>(
    `SELECT ${COLS} FROM holistic_evaluation
      WHERE golden_set_id = $1 AND pass_index = $2
      ORDER BY submission_id`, [goldenSetId, passIndex])
  return res.rows
}

/** The challenge and the text of its brief, through the published view (P1.3). */
export async function selectBrief(challengeId: number): Promise<{
  name: string; description: string | null; brief_text: string | null
} | null> {
  return queryOne(
    'SELECT name, description, brief_text FROM v_challenges_brief WHERE challenge_id = $1',
    [challengeId])
}

/** The golden set's entries with the submission each was scored as, and its expected band. */
export async function selectSetSubjects(goldenSetId: number): Promise<Array<{
  entry_id: number; label: string; expected_band: string; edge_case: string | null
  submission_id: number; challenge_id: number
}>> {
  const res = await query<{
    entry_id: number; label: string; expected_band: string; edge_case: string | null
    submission_id: number; challenge_id: number
  }>(
    `SELECT e.entry_id, e.label, e.expected_band, e.edge_case, e.submission_id, s.challenge_id
       FROM golden_entry e
       JOIN v_submissions_submission s ON s.submission_id = e.submission_id
      WHERE e.golden_set_id = $1 AND e.submission_id IS NOT NULL
      ORDER BY e.entry_id`, [goldenSetId])
  return res.rows
}

/** The per-criterion composite for the same submissions, to rank the two approaches against. */
export async function selectCompositesFor(
  submissionIds: readonly number[], cohortKey: string, runIndex: number,
): Promise<Array<{ submission_id: number; composite: string; rank_global: number }>> {
  if (submissionIds.length === 0) return []
  const res = await query<{ submission_id: number; composite: string; rank_global: number }>(
    `SELECT c.submission_id, c.composite, c.rank_global
       FROM submission_composite c
       JOIN score_run r ON r.run_index_id = c.run_index_id
      WHERE c.submission_id = ANY($1::bigint[]) AND r.cohort_key = $2 AND r.run_index = $3
      ORDER BY c.rank_global`, [submissionIds, cohortKey, runIndex])
  return res.rows
}
