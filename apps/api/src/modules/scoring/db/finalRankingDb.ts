/**
 * All SQL for the final ranking (P1.2, E50).
 */
import { query, queryOne, tx } from '../../../db/pool.js'

export interface FinalRow {
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
  disagreement: boolean
  partial: boolean
}

export interface FinalSnapshotRow {
  cohort_key: string
  run1_index_id: number
  run2_index_id: number
  weights: Record<string, number>
  cut_line_used: number
  band_size_used: number
  threshold_used: number
  submissions: number
  computed_by: string | null
  computed_at: Date
}

export async function replaceFinalRanking(
  rows: readonly Omit<FinalRow, 'cohort_key'>[],
  snapshot: Omit<FinalSnapshotRow, 'computed_at'>,
): Promise<void> {
  await tx(async (client) => {
    await client.query('DELETE FROM cohort_final_ranking WHERE cohort_key = $1', [snapshot.cohort_key])
    for (const r of rows) {
      await client.query(
        `INSERT INTO cohort_final_ranking
           (cohort_key, submission_id, challenge_id, team_name, composite_run1, composite_run2,
            composite_final, single_run, delta, rank_global, rank_in_challenge, tied, in_cut_band,
            disagreement, partial)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [snapshot.cohort_key, r.submission_id, r.challenge_id, r.team_name, r.composite_run1,
         r.composite_run2, r.composite_final, r.single_run, r.delta, r.rank_global,
         r.rank_in_challenge, r.tied, r.in_cut_band, r.disagreement, r.partial])
    }
    await client.query(
      `INSERT INTO cohort_final_snapshot
         (cohort_key, run1_index_id, run2_index_id, weights, cut_line_used, band_size_used,
          threshold_used, submissions, computed_by, computed_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9, now())
       ON CONFLICT (cohort_key) DO UPDATE SET
         run1_index_id = EXCLUDED.run1_index_id, run2_index_id = EXCLUDED.run2_index_id,
         weights = EXCLUDED.weights, cut_line_used = EXCLUDED.cut_line_used,
         band_size_used = EXCLUDED.band_size_used, threshold_used = EXCLUDED.threshold_used,
         submissions = EXCLUDED.submissions, computed_by = EXCLUDED.computed_by, computed_at = now()`,
      [snapshot.cohort_key, snapshot.run1_index_id, snapshot.run2_index_id,
       JSON.stringify(snapshot.weights), snapshot.cut_line_used, snapshot.band_size_used,
       snapshot.threshold_used, snapshot.submissions, snapshot.computed_by])
  })
}

export async function selectFinalRanking(cohortKey: string): Promise<FinalRow[]> {
  const res = await query<FinalRow>(
    'SELECT * FROM v_scoring_final_ranking WHERE cohort_key = $1 ORDER BY rank_global', [cohortKey])
  return res.rows.map((r) => ({
    ...r,
    submission_id: Number(r.submission_id), challenge_id: Number(r.challenge_id),
    composite_run1: r.composite_run1 === null ? null : Number(r.composite_run1),
    composite_run2: r.composite_run2 === null ? null : Number(r.composite_run2),
    composite_final: Number(r.composite_final), delta: r.delta === null ? null : Number(r.delta),
  }))
}

export async function selectFinalSnapshot(cohortKey: string): Promise<FinalSnapshotRow | null> {
  const row = await queryOne<FinalSnapshotRow>(
    'SELECT * FROM cohort_final_snapshot WHERE cohort_key = $1', [cohortKey])
  return row
    ? { ...row, run1_index_id: Number(row.run1_index_id), run2_index_id: Number(row.run2_index_id),
      threshold_used: Number(row.threshold_used) }
    : null
}
