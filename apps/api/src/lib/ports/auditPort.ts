/**
 * Audit port (P1.2, P1.3, Appendix C).
 *
 * Auditing is cross-cutting: the run ledger, the rubric service and the review service all need
 * to record a consequential action, but `audit_event` is owned by the governance module and
 * Appendix C forbids importing another module's service or writing its tables.
 *
 * The resolution is a port. Modules depend on this interface only. The governance module
 * registers the implementation at boot. Extracting governance into its own service later is
 * then a wiring change — swap the in-process implementation for an HTTP client — with no call
 * site edited, which is exactly what P1.2 requires.
 */
import { createLogger } from '../logger.js'

const log = createLogger('platform', 'auditPort')

export interface AuditEventInput {
  actor: string
  /** Dotted, past-tense action name, e.g. `rubric.frozen`, `shortlist.finalised`. */
  action: string
  subjectType: string
  subjectId: string
  payload?: Record<string, unknown>
}

export interface AuditPort {
  record(event: AuditEventInput): Promise<void>
}

/**
 * Until governance registers a real implementation, auditing is a loud no-op: it warns rather
 * than throwing, because a missing audit sink must not take down the operation being audited —
 * but it must never be silent, or a misconfigured boot would quietly lose the entire trail.
 */
const unregistered: AuditPort = {
  async record(event) {
    log.warn('audit event dropped — no audit port registered', {
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
    })
  },
}

let impl: AuditPort = unregistered

export function registerAuditPort(port: AuditPort): void {
  impl = port
}

/** Test seam — restores the unregistered no-op. */
export function resetAuditPort(): void {
  impl = unregistered
}

/**
 * Record a consequential action (E09-S01).
 *
 * Never throws: an audit write failing must not fail the action it describes. Failures are
 * logged at error so they are alertable (P9.5).
 */
export async function recordAudit(event: AuditEventInput): Promise<void> {
  try {
    await impl.record(event)
  } catch (err) {
    log.error('audit write failed', { err, action: event.action, subjectId: event.subjectId })
  }
}
