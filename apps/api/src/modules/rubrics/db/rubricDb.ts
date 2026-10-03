/**
 * All SQL for rubrics and criteria (P1.2).
 *
 * The database shape is deliberately flat (anchor_0 … anchor_4 as columns rather than JSON), so
 * the NOT NULL and CHECK constraints in migration 008 can enforce "five anchors, none empty" at
 * the storage layer instead of trusting the application to have validated first (P8.5).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type {
  Criterion, Dimension, DimensionWeights, Rubric, RubricStatus,
} from '@crucible/rubric'

export interface RubricRow {
  rubric_id: number; challenge_id: number; version: number; status: RubricStatus
  content_hash: string | null; dimension_weights: DimensionWeights
  generated_by: string | null; generated_at: Date | null
  approved_by: string | null; approved_at: Date | null
  frozen_at: Date | null; published_at: Date | null; previous_id: number | null
}

interface CriterionRow {
  criterion_id: number; rubric_id: number; dimension: Dimension; name: string
  description: string; weight: number; evidence_spec: string
  anchor_0: string; anchor_1: string; anchor_2: string; anchor_3: string; anchor_4: string
  source_ref: string | null; sort_order: number
  needs_rewrite: boolean; gate_notes: string[]
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export function toCriterion(r: CriterionRow): Criterion {
  const criterion: Criterion = {
    criterionId: String(r.criterion_id),
    dimension: r.dimension,
    name: r.name,
    description: r.description,
    weight: Number(r.weight),
    evidenceSpec: r.evidence_spec,
    anchors: {
      0: r.anchor_0, 1: r.anchor_1, 2: r.anchor_2, 3: r.anchor_3, 4: r.anchor_4,
    },
    sortOrder: r.sort_order,
  }
  if (r.source_ref !== null) criterion.sourceRef = r.source_ref
  if (r.needs_rewrite) criterion.needsRewrite = true
  if (r.gate_notes.length > 0) criterion.gateNotes = r.gate_notes
  return criterion
}

export function toRubric(r: RubricRow, criteria: Criterion[]): Rubric {
  return {
    rubricId: String(r.rubric_id),
    challengeId: String(r.challenge_id),
    version: r.version,
    status: r.status,
    contentHash: r.content_hash,
    dimensionWeights: r.dimension_weights,
    criteria,
    generatedAt: iso(r.generated_at),
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    frozenAt: iso(r.frozen_at),
    publishedAt: iso(r.published_at),
  }
}

export async function insertRubric(input: {
  challengeId: number; version: number; dimensionWeights: DimensionWeights
  generatedBy: string | null; previousId: number | null
}, client?: DbClient): Promise<RubricRow> {
  const row = await queryOne<RubricRow>(
    `INSERT INTO rubric (challenge_id, version, dimension_weights, generated_by, generated_at, previous_id)
     VALUES ($1, $2, $3::jsonb, $4, now(), $5) RETURNING *`,
    [input.challengeId, input.version, JSON.stringify(input.dimensionWeights),
     input.generatedBy, input.previousId], client)
  if (!row) throw new Error('insertRubric returned no row')
  return row
}

export async function selectRubricRow(rubricId: number): Promise<RubricRow | null> {
  return queryOne<RubricRow>('SELECT * FROM rubric WHERE rubric_id = $1', [rubricId])
}

export async function selectCriteria(rubricId: number): Promise<Criterion[]> {
  const res = await query<CriterionRow>(
    'SELECT * FROM rubric_criterion WHERE rubric_id = $1 ORDER BY sort_order, criterion_id',
    [rubricId])
  return res.rows.map(toCriterion)
}

export async function selectRubricsForChallenge(challengeId: number): Promise<RubricRow[]> {
  const res = await query<RubricRow>(
    'SELECT * FROM rubric WHERE challenge_id = $1 ORDER BY version DESC', [challengeId])
  return res.rows
}

export async function selectLatestVersion(challengeId: number): Promise<number> {
  const row = await queryOne<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM rubric WHERE challenge_id = $1', [challengeId])
  return row?.v ?? 0
}

export async function selectFrozenRubricRow(challengeId: number): Promise<RubricRow | null> {
  return queryOne<RubricRow>(
    `SELECT * FROM rubric WHERE challenge_id = $1 AND status = 'FROZEN'`, [challengeId])
}

export async function selectPublishedBySlug(slug: string): Promise<RubricRow | null> {
  return queryOne<RubricRow>(
    `SELECT r.* FROM rubric r
       JOIN v_challenges_challenge c ON c.challenge_id = r.challenge_id
      WHERE c.slug = $1 AND r.status = 'FROZEN' AND r.published_at IS NOT NULL`,
    [slug])
}

export interface CriterionInput {
  dimension: Dimension; name: string; description: string; weight: number
  evidenceSpec: string; anchors: Record<0 | 1 | 2 | 3 | 4, string>
  sourceRef: string | null; sortOrder: number
  needsRewrite?: boolean; gateNotes?: string[]
}

export async function insertCriterion(
  rubricId: number, c: CriterionInput, client?: DbClient,
): Promise<Criterion> {
  const row = await queryOne<CriterionRow>(
    `INSERT INTO rubric_criterion
       (rubric_id, dimension, name, description, weight, evidence_spec,
        anchor_0, anchor_1, anchor_2, anchor_3, anchor_4, source_ref, sort_order,
        needs_rewrite, gate_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING *`,
    [rubricId, c.dimension, c.name, c.description, c.weight, c.evidenceSpec,
     c.anchors[0], c.anchors[1], c.anchors[2], c.anchors[3], c.anchors[4],
     c.sourceRef, c.sortOrder, c.needsRewrite ?? false,
     JSON.stringify(c.gateNotes ?? [])], client)
  if (!row) throw new Error('insertCriterion returned no row')
  return toCriterion(row)
}

/** Columns a patch may touch, mapped to their SQL column names. */
const CRITERION_COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  weight: 'weight',
  evidenceSpec: 'evidence_spec',
  sourceRef: 'source_ref',
  sortOrder: 'sort_order',
  needsRewrite: 'needs_rewrite',
}

/**
 * Patch a criterion.
 *
 * The SET clause is built from the fields actually supplied rather than COALESCEing every
 * column. Besides being simpler, it preserves a real distinction the COALESCE form destroys:
 * "leave source_ref alone" and "clear source_ref" are different intentions, and COALESCE
 * silently collapses them into the first.
 */
export async function updateCriterion(
  criterionId: number, patch: Partial<CriterionInput>,
): Promise<Criterion | null> {
  const sets: string[] = []
  const values: unknown[] = [criterionId]

  for (const [key, column] of Object.entries(CRITERION_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[key]
    if (value === undefined) continue
    values.push(value)
    sets.push(`${column} = $${values.length}`)
  }

  if (patch.anchors) {
    for (const level of [0, 1, 2, 3, 4] as const) {
      values.push(patch.anchors[level])
      sets.push(`anchor_${level} = $${values.length}`)
    }
  }

  if (sets.length === 0) {
    const row = await queryOne<CriterionRow>(
      'SELECT * FROM rubric_criterion WHERE criterion_id = $1', [criterionId])
    return row ? toCriterion(row) : null
  }

  const row = await queryOne<CriterionRow>(
    `UPDATE rubric_criterion SET ${sets.join(', ')} WHERE criterion_id = $1 RETURNING *`,
    values)
  return row ? toCriterion(row) : null
}

export async function deleteCriterion(criterionId: number): Promise<boolean> {
  const res = await query('DELETE FROM rubric_criterion WHERE criterion_id = $1', [criterionId])
  return res.rowCount > 0
}

export async function updateRubricStatus(input: {
  rubricId: number; status: RubricStatus; actor?: string | null
  contentHash?: string | null; freeze?: boolean; publish?: boolean
}, client?: DbClient): Promise<RubricRow | null> {
  return queryOne<RubricRow>(
    `UPDATE rubric SET
       status       = $2,
       approved_by  = COALESCE($3, approved_by),
       approved_at  = CASE WHEN $2 = 'APPROVED' THEN now() ELSE approved_at END,
       content_hash = COALESCE($4, content_hash),
       frozen_at    = CASE WHEN $5 THEN now() ELSE frozen_at END,
       published_at = CASE WHEN $6 THEN now() ELSE published_at END
     WHERE rubric_id = $1 RETURNING *`,
    [input.rubricId, input.status, input.actor ?? null, input.contentHash ?? null,
     input.freeze ?? false, input.publish ?? false], client)
}

export async function updateDimensionWeights(
  rubricId: number, weights: DimensionWeights,
): Promise<RubricRow | null> {
  return queryOne<RubricRow>(
    `UPDATE rubric SET dimension_weights = $2::jsonb WHERE rubric_id = $1 RETURNING *`,
    [rubricId, JSON.stringify(weights)])
}
