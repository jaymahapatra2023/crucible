import { useState } from 'react'
import type { Readiness } from '../lib/rubricApi.js'

/**
 * Approval gate (E02-S06 acceptance 2 and 4).
 *
 * Errors block approval outright. Warnings block it until each one is explicitly acknowledged —
 * the checkbox is the acknowledgement, and the button stays disabled until every warning has
 * one. A reviewer cannot approve past a quality-gate concern without having seen it.
 */
export function ApprovalPanel({
  readiness,
  status,
  busy,
  onApprove,
  onFreeze,
  onPublish,
}: {
  readiness: Readiness
  status: string
  busy: boolean
  onApprove: (acknowledged: string[]) => void
  onFreeze: () => void
  onPublish: () => void
}) {
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())

  const warningCodes = [...new Set(readiness.report.warnings.map((w) => w.code))]
  const allAcknowledged = warningCodes.every((code) => acknowledged.has(code))
  const canApprove = readiness.report.errors.length === 0 && allAcknowledged

  const toggle = (code: string) => setAcknowledged((prev) => {
    const next = new Set(prev)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    return next
  })

  return (
    <section
      style={{
        border: '1px solid var(--border)', borderRadius: 8, padding: 16,
        background: 'var(--surface)', marginBottom: 20,
      }}
    >
      <h2 style={{ fontSize: 15, marginTop: 0 }}>Approval</h2>

      {readiness.report.errors.length > 0 && (
        <div role="alert" style={{ marginBottom: 12 }}>
          <strong style={{ color: 'var(--danger)' }}>
            {readiness.report.errors.length} problem(s) must be fixed before approval
          </strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {readiness.report.errors.map((e, i) => <li key={i}>{e.message}</li>)}
          </ul>
        </div>
      )}

      {warningCodes.length > 0 && (
        <fieldset style={{ border: '1px solid var(--warn)', borderRadius: 6, marginBottom: 12 }}>
          <legend style={{ color: 'var(--warn)', fontWeight: 600, padding: '0 6px' }}>
            Acknowledge before approving
          </legend>
          {readiness.report.warnings.map((w, i) => (
            <label key={i} style={{ display: 'block', margin: '6px 0' }}>
              <input
                type="checkbox"
                checked={acknowledged.has(w.code)}
                onChange={() => toggle(w.code)}
              />{' '}
              {w.message}
            </label>
          ))}
        </fieldset>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={busy || !canApprove || status !== 'DRAFT'}
          onClick={() => onApprove([...acknowledged])}
          style={primaryButton}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy || status !== 'APPROVED'}
          onClick={onFreeze}
          style={secondaryButton}
          title="Freezing records the content hash and makes the rubric immutable"
        >
          Freeze
        </button>
        <button
          type="button"
          disabled={busy || status !== 'FROZEN'}
          onClick={onPublish}
          style={secondaryButton}
        >
          Publish to teams
        </button>
      </div>

      {!canApprove && status === 'DRAFT' && (
        <p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>
          {readiness.report.errors.length > 0
            ? 'Fix the problems above to enable approval.'
            : 'Acknowledge every warning above to enable approval.'}
        </p>
      )}
    </section>
  )
}

const primaryButton: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, font: 'inherit', fontWeight: 600,
  border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: 'pointer',
}

const secondaryButton: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, font: 'inherit',
  border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer',
}
