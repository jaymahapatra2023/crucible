/**
 * SQL for principles, standards and their assessments (E06-S03).
 */
import { query, queryOne } from '../../../db/pool.js'

export interface PrincipleRow {
  principle_id: number
  code: string
  name: string
  description: string
  evidence_spec: string
  anchor_0: string
  anchor_1: string
  anchor_2: string
  anchor_3: string
  anchor_4: string
  active: boolean
  sort_order: number
}

export interface StandardRow {
  standard_id: number
  code: string
  name: string
  description: string
  evidence_spec: string
  active: boolean
  sort_order: number
}

/**
 * Only ACTIVE principles are assessed (OD-2).
 *
 * The nine pillars ship inactive. A committee that has not chosen a list gets an empty
 * assessment and a visible gap, rather than being quietly held to a default nobody adopted.
 */
export async function selectActivePrinciples(): Promise<PrincipleRow[]> {
  const res = await query<PrincipleRow>(
    'SELECT * FROM arch_principle WHERE active ORDER BY sort_order, code')
  return res.rows
}

export async function selectActiveStandards(): Promise<StandardRow[]> {
  const res = await query<StandardRow>(
    'SELECT * FROM it_standard WHERE active ORDER BY sort_order, code')
  return res.rows
}

export async function listPrinciples(): Promise<PrincipleRow[]> {
  const res = await query<PrincipleRow>('SELECT * FROM arch_principle ORDER BY sort_order, code')
  return res.rows
}

export async function listStandards(): Promise<StandardRow[]> {
  const res = await query<StandardRow>('SELECT * FROM it_standard ORDER BY sort_order, code')
  return res.rows
}

export async function setPrincipleActive(
  principleId: number, active: boolean,
): Promise<PrincipleRow | null> {
  return queryOne<PrincipleRow>(
    'UPDATE arch_principle SET active = $2 WHERE principle_id = $1 RETURNING *',
    [principleId, active])
}

export async function setStandardActive(
  standardId: number, active: boolean,
): Promise<StandardRow | null> {
  return queryOne<StandardRow>(
    'UPDATE it_standard SET active = $2 WHERE standard_id = $1 RETURNING *',
    [standardId, active])
}

export interface AssessmentEvidence {
  path: string
  lineStart: number
  lineEnd: number
  excerpt: string
}

export interface PrincipleAssessmentRow {
  id: number
  run_index_id: number
  submission_id: number
  principle_id: number
  maturity: number | null
  non_score: string | null
  confidence: number
  rationale: string
  evidence: AssessmentEvidence[]
  assessed_at: Date
}

export async function upsertPrincipleAssessment(input: {
  runIndexId: number
  submissionId: number
  principleId: number
  maturity: number | null
  nonScore: string | null
  confidence: number
  rationale: string
  evidence: AssessmentEvidence[]
}): Promise<PrincipleAssessmentRow> {
  const row = await queryOne<PrincipleAssessmentRow>(
    `INSERT INTO principle_assessment
       (run_index_id, submission_id, principle_id, maturity, non_score, confidence,
        rationale, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (run_index_id, submission_id, principle_id) DO UPDATE SET
       maturity = EXCLUDED.maturity, non_score = EXCLUDED.non_score,
       confidence = EXCLUDED.confidence, rationale = EXCLUDED.rationale,
       evidence = EXCLUDED.evidence, assessed_at = now()
     RETURNING *`,
    [input.runIndexId, input.submissionId, input.principleId, input.maturity, input.nonScore,
     input.confidence, input.rationale, JSON.stringify(input.evidence)])
  if (!row) throw new Error('upsertPrincipleAssessment returned no row')
  return row
}

export interface StandardAssessmentRow {
  id: number
  run_index_id: number
  submission_id: number
  standard_id: number
  compliance: string | null
  non_score: string | null
  confidence: number
  rationale: string
  evidence: AssessmentEvidence[]
  assessed_at: Date
}

export async function upsertStandardAssessment(input: {
  runIndexId: number
  submissionId: number
  standardId: number
  compliance: string | null
  nonScore: string | null
  confidence: number
  rationale: string
  evidence: AssessmentEvidence[]
}): Promise<StandardAssessmentRow> {
  const row = await queryOne<StandardAssessmentRow>(
    `INSERT INTO standard_assessment
       (run_index_id, submission_id, standard_id, compliance, non_score, confidence,
        rationale, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (run_index_id, submission_id, standard_id) DO UPDATE SET
       compliance = EXCLUDED.compliance, non_score = EXCLUDED.non_score,
       confidence = EXCLUDED.confidence, rationale = EXCLUDED.rationale,
       evidence = EXCLUDED.evidence, assessed_at = now()
     RETURNING *`,
    [input.runIndexId, input.submissionId, input.standardId, input.compliance, input.nonScore,
     input.confidence, input.rationale, JSON.stringify(input.evidence)])
  if (!row) throw new Error('upsertStandardAssessment returned no row')
  return row
}

export async function selectPrincipleAssessments(
  runIndexId: number, submissionId: number,
): Promise<Array<PrincipleAssessmentRow & { code: string; name: string }>> {
  const res = await query<PrincipleAssessmentRow & { code: string; name: string }>(
    `SELECT pa.*, p.code, p.name FROM principle_assessment pa
       JOIN arch_principle p ON p.principle_id = pa.principle_id
      WHERE pa.run_index_id = $1 AND pa.submission_id = $2
      ORDER BY p.sort_order, p.code`,
    [runIndexId, submissionId])
  return res.rows
}

export async function selectStandardAssessments(
  runIndexId: number, submissionId: number,
): Promise<Array<StandardAssessmentRow & { code: string; name: string }>> {
  const res = await query<StandardAssessmentRow & { code: string; name: string }>(
    `SELECT sa.*, s.code, s.name FROM standard_assessment sa
       JOIN it_standard s ON s.standard_id = sa.standard_id
      WHERE sa.run_index_id = $1 AND sa.submission_id = $2
      ORDER BY s.sort_order, s.code`,
    [runIndexId, submissionId])
  return res.rows
}

/** Every principle assessment in a run, for the composite pass. */
export async function selectRunPrincipleOutcomes(runIndexId: number): Promise<
  Array<{ submissionId: number; principleId: number; maturity: number | null; nonScore: string | null }>
> {
  const res = await query<{
    submission_id: number; principle_id: number; maturity: number | null; non_score: string | null
  }>(
    `SELECT submission_id, principle_id, maturity, non_score FROM principle_assessment
      WHERE run_index_id = $1 ORDER BY submission_id, principle_id`,
    [runIndexId])
  return res.rows.map((r) => ({
    submissionId: r.submission_id, principleId: r.principle_id,
    maturity: r.maturity, nonScore: r.non_score,
  }))
}

/** Every standard assessment in a run, for the composite pass. */
export async function selectRunStandardOutcomes(runIndexId: number): Promise<
  Array<{ submissionId: number; standardId: number; compliance: string | null; nonScore: string | null }>
> {
  const res = await query<{
    submission_id: number; standard_id: number; compliance: string | null; non_score: string | null
  }>(
    `SELECT submission_id, standard_id, compliance, non_score FROM standard_assessment
      WHERE run_index_id = $1 ORDER BY submission_id, standard_id`,
    [runIndexId])
  return res.rows.map((r) => ({
    submissionId: r.submission_id, standardId: r.standard_id,
    compliance: r.compliance, nonScore: r.non_score,
  }))
}

export const PILLARS = [
  'SECURITY', 'RELIABILITY', 'OBSERVABILITY', 'API_FIRST', 'DATA',
  'MODULARITY', 'COST', 'DEVELOPER_EXPERIENCE', 'CLOUD_NATIVE', 'OTHER',
] as const

export const STANDARD_CATEGORIES = [
  'SECURITY', 'ARCHITECTURE', 'COMPLIANCE', 'OPERATIONAL', 'DATA_GOVERNANCE', 'OTHER',
] as const

export interface PrincipleInput {
  code: string
  pillar: string
  name: string
  description: string
  rationale: string
  guidance: string
  evidenceSpec: string
  anchors: [string, string, string, string, string]
  sourceRefs: string[]
  tags: string[]
  owner: string | null
  sortOrder: number
}

export async function insertPrinciple(input: PrincipleInput, actor: string): Promise<PrincipleRow> {
  const row = await queryOne<PrincipleRow>(
    `INSERT INTO arch_principle
       (code, pillar, name, description, rationale, guidance, evidence_spec,
        anchor_0, anchor_1, anchor_2, anchor_3, anchor_4,
        source_refs, tags, owner, sort_order, created_by, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14::text[],$15,$16,$17,FALSE)
     RETURNING *`,
    [input.code, input.pillar, input.name, input.description, input.rationale, input.guidance,
     input.evidenceSpec, ...input.anchors,
     input.sourceRefs, input.tags, input.owner, input.sortOrder, actor])
  if (!row) throw new Error('insertPrinciple returned no row')
  return row
}

/**
 * Update a principle in place.
 *
 * Adoption is deliberately NOT updatable here: adopting a principle is a separate, audited act
 * (`setPrincipleActive`), and letting an edit flip it would let a wording change quietly put a
 * principle into or out of the evaluation.
 */
export async function updatePrinciple(
  principleId: number, input: PrincipleInput,
): Promise<PrincipleRow | null> {
  return queryOne<PrincipleRow>(
    `UPDATE arch_principle SET
       code = $2, pillar = $3, name = $4, description = $5, rationale = $6, guidance = $7,
       evidence_spec = $8, anchor_0 = $9, anchor_1 = $10, anchor_2 = $11, anchor_3 = $12,
       anchor_4 = $13, source_refs = $14::text[], tags = $15::text[], owner = $16,
       sort_order = $17, updated_at = now()
     WHERE principle_id = $1 RETURNING *`,
    [principleId, input.code, input.pillar, input.name, input.description, input.rationale,
     input.guidance, input.evidenceSpec, ...input.anchors,
     input.sourceRefs, input.tags, input.owner, input.sortOrder])
}

export interface StandardInput {
  code: string
  category: string
  name: string
  description: string
  rationale: string
  evidenceSpec: string
  mandatory: boolean
  appliesTo: string[]
  tags: string[]
  sourceDocument: string | null
  owner: string | null
  effectiveDate: string | null
  reviewDate: string | null
  sortOrder: number
}

export async function insertStandard(input: StandardInput, actor: string): Promise<StandardRow> {
  const row = await queryOne<StandardRow>(
    `INSERT INTO it_standard
       (code, category, name, description, rationale, evidence_spec, mandatory,
        applies_to, tags, source_document, owner, effective_date, review_date,
        sort_order, created_by, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10,$11,$12,$13,$14,$15,FALSE)
     RETURNING *`,
    [input.code, input.category, input.name, input.description, input.rationale,
     input.evidenceSpec, input.mandatory, input.appliesTo, input.tags,
     input.sourceDocument, input.owner, input.effectiveDate, input.reviewDate,
     input.sortOrder, actor])
  if (!row) throw new Error('insertStandard returned no row')
  return row
}

export async function updateStandard(
  standardId: number, input: StandardInput,
): Promise<StandardRow | null> {
  return queryOne<StandardRow>(
    `UPDATE it_standard SET
       code = $2, category = $3, name = $4, description = $5, rationale = $6,
       evidence_spec = $7, mandatory = $8, applies_to = $9::text[], tags = $10::text[],
       source_document = $11, owner = $12, effective_date = $13, review_date = $14,
       sort_order = $15, updated_at = now()
     WHERE standard_id = $1 RETURNING *`,
    [standardId, input.code, input.category, input.name, input.description, input.rationale,
     input.evidenceSpec, input.mandatory, input.appliesTo, input.tags,
     input.sourceDocument, input.owner, input.effectiveDate, input.reviewDate, input.sortOrder])
}

/** How many assessments already cite this principle — what makes deleting it destructive. */
export async function principleUsage(principleId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM principle_assessment WHERE principle_id = $1', [principleId])
  return row?.n ?? 0
}

export async function standardUsage(standardId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM standard_assessment WHERE standard_id = $1', [standardId])
  return row?.n ?? 0
}

export async function deletePrinciple(principleId: number): Promise<boolean> {
  const row = await queryOne<{ principle_id: number }>(
    'DELETE FROM arch_principle WHERE principle_id = $1 RETURNING principle_id', [principleId])
  return row !== null
}

export async function deleteStandard(standardId: number): Promise<boolean> {
  const row = await queryOne<{ standard_id: number }>(
    'DELETE FROM it_standard WHERE standard_id = $1 RETURNING standard_id', [standardId])
  return row !== null
}
