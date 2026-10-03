/**
 * Audit trail (E09-S01).
 *
 * Writes are append-only at the database level (migration 003 installs a trigger that refuses
 * UPDATE and DELETE), so this service has no update or delete path to offer — acceptance 3 is a
 * property of the schema, not a convention this file observes.
 */
import { createLogger } from '../../../lib/logger.js'
import { currentCorrelationId } from '../../../lib/correlation.js'
import { registerAuditPort, type AuditEventInput } from '../../../lib/ports/auditPort.js'
import {
  countAudit, insertAudit, selectAudit, selectAuditForSubject,
  type AuditFilter, type AuditRow,
} from '../db/auditDb.js'

const log = createLogger('governance', 'audit')

export interface AuditEvent {
  eventId: number
  actor: string
  action: string
  subjectType: string
  subjectId: string
  payload: Record<string, unknown>
  correlationId: string | null
  at: Date
}

const toEvent = (r: AuditRow): AuditEvent => ({
  eventId: r.event_id,
  actor: r.actor,
  action: r.action,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  payload: r.payload,
  correlationId: r.correlation_id,
  at: r.at,
})

/**
 * Write one audit event. The correlation id is taken from the ambient scope (P9.2) so a caller
 * cannot forget it and an event is always tied back to the request or run that caused it.
 */
export async function writeAudit(event: AuditEventInput): Promise<void> {
  await insertAudit({
    actor: event.actor,
    action: event.action,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    payload: event.payload ?? {},
    correlationId: currentCorrelationId() ?? null,
  })
}

export async function listAudit(
  filter: AuditFilter,
  limit: number,
  offset: number,
): Promise<{ events: AuditEvent[]; total: number }> {
  const [rows, total] = await Promise.all([
    selectAudit(filter, limit, offset),
    countAudit(filter),
  ])
  return { events: rows.map(toEvent), total }
}

/** The full, ordered trail for one subject — used by the appeal packet (E09-S02). */
export async function auditTrailFor(subjectType: string, subjectId: string): Promise<AuditEvent[]> {
  return (await selectAuditForSubject(subjectType, subjectId)).map(toEvent)
}

/**
 * Register this module as the process-wide audit implementation. Called once at boot; every
 * other module reaches auditing through the port rather than importing this file (P1.3).
 */
export function installAuditPort(): void {
  registerAuditPort({ record: writeAudit })
  log.info('audit port registered')
}
