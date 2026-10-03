/**
 * All SQL for the audit trail. The governance module owns `audit_event` (P1.3); every other
 * module reaches it through the audit port, never through this file.
 */
import { query, queryOne } from '../../../db/pool.js'

export interface AuditRow {
  event_id: number
  actor: string
  action: string
  subject_type: string
  subject_id: string
  payload: Record<string, unknown>
  correlation_id: string | null
  at: Date
}

export async function insertAudit(input: {
  actor: string
  action: string
  subjectType: string
  subjectId: string
  payload: Record<string, unknown>
  correlationId: string | null
}): Promise<void> {
  await query(
    `INSERT INTO audit_event (actor, action, subject_type, subject_id, payload, correlation_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [input.actor, input.action, input.subjectType, input.subjectId,
     JSON.stringify(input.payload), input.correlationId],
  )
}

export interface AuditFilter {
  subjectType?: string
  subjectId?: string
  actor?: string
  action?: string
}

function whereClause(f: AuditFilter, from = 1): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  let i = from
  if (f.subjectType) { parts.push(`subject_type = $${i++}`); params.push(f.subjectType) }
  if (f.subjectId) { parts.push(`subject_id = $${i++}`); params.push(f.subjectId) }
  if (f.actor) { parts.push(`actor = $${i++}`); params.push(f.actor) }
  if (f.action) { parts.push(`action = $${i++}`); params.push(f.action) }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

export async function selectAudit(f: AuditFilter, limit: number, offset: number): Promise<AuditRow[]> {
  const { sql, params } = whereClause(f, 3)
  const res = await query<AuditRow>(
    `SELECT event_id, actor, action, subject_type, subject_id, payload, correlation_id, at
       FROM audit_event ${sql}
      ORDER BY at DESC, event_id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, ...params],
  )
  return res.rows
}

/** Real backend count (P5.7) — the audit view must never show a fetch length as a total. */
export async function countAudit(f: AuditFilter): Promise<number> {
  const { sql, params } = whereClause(f, 1)
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_event ${sql}`, params)
  return row?.n ?? 0
}

/** Every audit row for one subject, oldest first — the backbone of the appeal packet (E09-S02). */
export async function selectAuditForSubject(subjectType: string, subjectId: string): Promise<AuditRow[]> {
  const res = await query<AuditRow>(
    `SELECT event_id, actor, action, subject_type, subject_id, payload, correlation_id, at
       FROM audit_event WHERE subject_type = $1 AND subject_id = $2
      ORDER BY at, event_id`,
    [subjectType, subjectId],
  )
  return res.rows
}
