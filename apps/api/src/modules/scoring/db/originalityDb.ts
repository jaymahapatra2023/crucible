/**
 * SQL for the advisory originality assessment (E06-S05).
 */
import { query, queryOne } from '../../../db/pool.js'

export interface OriginalityRow {
  id: number
  run_index_id: number
  submission_id: number
  level: number | null
  non_score: string | null
  confidence: number
  rationale: string
  observations: string[]
  evidence: Array<{ path: string; lineStart: number; lineEnd: number; excerpt: string }>
  /** NUMERIC, parsed to a JS number by the pool's type parser — not a string. */
  boilerplate_share_pct: number
  scaffold_lines: number
  substantive_lines: number
  templates: Array<{ id: string; name: string; matchedOn: string }>
  provenance_flags: Array<{ code: string; message: string }>
  model: string | null
  cost_usd: number
  assessed_at: Date
}

export async function upsertOriginality(input: {
  runIndexId: number
  submissionId: number
  level: number | null
  nonScore: string | null
  confidence: number
  rationale: string
  observations: string[]
  evidence: Array<{ path: string; lineStart: number; lineEnd: number; excerpt: string }>
  boilerplateSharePct: number
  scaffoldLines: number
  substantiveLines: number
  templates: Array<{ id: string; name: string; matchedOn: string }>
  provenanceFlags: Array<{ code: string; message: string }>
  model: string | null
  costUsd: number
}): Promise<OriginalityRow> {
  const row = await queryOne<OriginalityRow>(
    `INSERT INTO originality_assessment
       (run_index_id, submission_id, level, non_score, confidence, rationale, observations,
        evidence, boilerplate_share_pct, scaffold_lines, substantive_lines, templates,
        provenance_flags, model, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15)
     ON CONFLICT (run_index_id, submission_id) DO UPDATE SET
       level = EXCLUDED.level, non_score = EXCLUDED.non_score,
       confidence = EXCLUDED.confidence, rationale = EXCLUDED.rationale,
       observations = EXCLUDED.observations, evidence = EXCLUDED.evidence,
       boilerplate_share_pct = EXCLUDED.boilerplate_share_pct,
       scaffold_lines = EXCLUDED.scaffold_lines,
       substantive_lines = EXCLUDED.substantive_lines,
       templates = EXCLUDED.templates, provenance_flags = EXCLUDED.provenance_flags,
       model = EXCLUDED.model, cost_usd = EXCLUDED.cost_usd, assessed_at = now()
     RETURNING *`,
    [input.runIndexId, input.submissionId, input.level, input.nonScore, input.confidence,
     input.rationale, JSON.stringify(input.observations), JSON.stringify(input.evidence),
     input.boilerplateSharePct, input.scaffoldLines, input.substantiveLines,
     JSON.stringify(input.templates), JSON.stringify(input.provenanceFlags),
     input.model, input.costUsd])
  if (!row) throw new Error('upsertOriginality returned no row')
  return row
}

export async function selectOriginality(
  runIndexId: number, submissionId: number,
): Promise<OriginalityRow | null> {
  return queryOne<OriginalityRow>(
    'SELECT * FROM originality_assessment WHERE run_index_id = $1 AND submission_id = $2',
    [runIndexId, submissionId])
}

/** Originality levels for a whole run, read from the published view (P1.3). */
export async function selectOriginalityLevels(
  runIndexId: number,
): Promise<Array<{ submissionId: number; level: number | null; nonScore: string | null }>> {
  const res = await query<{ submission_id: number; level: number | null; non_score: string | null }>(
    'SELECT submission_id, level, non_score FROM v_scoring_originality WHERE run_index_id = $1',
    [runIndexId])
  return res.rows.map((r) => ({
    submissionId: r.submission_id, level: r.level, nonScore: r.non_score,
  }))
}
