/**
 * SQL for review flags (E08-S03).
 */
import { query, queryOne, tx } from '../../../db/pool.js'

export interface FlagRow {
  run_index_id: number
  submission_id: number
  code: string
  severity: string
  message: string
  detail: Record<string, unknown>
  dismissed: boolean
  dismissed_by: string | null
  dismissal_reason: string | null
  dismissed_at: Date | null
  raised_at: Date
}

export interface FlagInsert {
  submissionId: number
  code: string
  severity: string
  message: string
  detail: Record<string, unknown>
}

/**
 * Replace a run's flags, keeping dismissals that still apply.
 *
 * A reviewer who has looked at a truncated scan and recorded why it is acceptable should not
 * have to look again because an unrelated submission was re-scored. Dismissals are therefore
 * carried across by (submission, code) — the identity of the caveat — rather than discarded
 * with the row. A flag that no longer applies simply disappears, dismissal and all.
 */
export async function replaceFlags(
  runIndexId: number, flags: readonly FlagInsert[],
): Promise<void> {
  await tx(async (client) => {
    const existing = await client.query<{
      submission_id: number; code: string; dismissed_at: Date | null
      dismissed_by: string | null; dismissal_reason: string | null
    }>(
      `SELECT submission_id, code, dismissed_at, dismissed_by, dismissal_reason
         FROM review_flag WHERE run_index_id = $1 AND dismissed_at IS NOT NULL`,
      [runIndexId])

    const dismissals = new Map(
      existing.rows.map((r) => [`${r.submission_id}:${r.code}`, r]))

    await client.query('DELETE FROM review_flag WHERE run_index_id = $1', [runIndexId])

    for (const flag of flags) {
      const prior = dismissals.get(`${flag.submissionId}:${flag.code}`)
      await client.query(
        `INSERT INTO review_flag
           (run_index_id, submission_id, code, severity, message, detail,
            dismissed_at, dismissed_by, dismissal_reason)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [runIndexId, flag.submissionId, flag.code, flag.severity, flag.message,
         JSON.stringify(flag.detail),
         prior?.dismissed_at ?? null, prior?.dismissed_by ?? null,
         prior?.dismissal_reason ?? null])
    }
  })
}

export async function selectFlags(
  runIndexId: number, submissionId?: number,
): Promise<FlagRow[]> {
  const res = await query<FlagRow>(
    `SELECT * FROM v_review_flags
      WHERE run_index_id = $1 AND ($2::bigint IS NULL OR submission_id = $2)
      ORDER BY submission_id, severity DESC, code`,
    [runIndexId, submissionId ?? null])
  return res.rows
}

export async function dismissFlagRow(input: {
  runIndexId: number
  submissionId: number
  code: string
  actor: string
  reason: string
}): Promise<FlagRow | null> {
  return queryOne<FlagRow>(
    `UPDATE review_flag
        SET dismissed_at = now(), dismissed_by = $4, dismissal_reason = $5
      WHERE run_index_id = $1 AND submission_id = $2 AND code = $3
      RETURNING run_index_id, submission_id, code, severity, message, detail,
                (dismissed_at IS NOT NULL) AS dismissed, dismissed_by, dismissal_reason,
                dismissed_at, raised_at`,
    [input.runIndexId, input.submissionId, input.code, input.actor, input.reason])
}
