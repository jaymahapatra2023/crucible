import { useState } from 'react'
import type { Finding } from '../lib/discoveryApi.js'

/**
 * Setting a security observation aside, having checked it (E16-S03).
 *
 * Every observation ships with what would make it benign. When a reviewer checks that and it IS
 * benign, this is where they say so — otherwise the observation stays amber, the next reviewer
 * repeats the work, and a checked observation looks identical to an unexamined one.
 *
 * A dismissed observation stays on the page, marked. Hiding it would be the same confusion in a
 * different direction: a reader could not tell "we looked and it was fine" from "we never
 * mentioned it".
 */
export function DismissObservation({
  finding, busy, onDismiss, onReinstate,
}: {
  finding: Finding
  busy: boolean
  onDismiss: (findingId: number, reason: string) => void
  onReinstate: (findingId: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  // Matches the table's own constraint. "ok" is not a reason, and a reason nobody can read is
  // the same as no reason at all.
  const usable = reason.trim().length >= 10

  if (finding.dismissed) {
    return (
      <p style={{
        margin: '8px 0 0', padding: '8px 10px', borderRadius: 6,
        background: 'var(--bg)', border: '1px solid var(--ok)',
      }}>
        <strong style={{ color: 'var(--ok)' }}>Checked and set aside</strong>
        {finding.dismissed_by && (
          <span style={{ color: 'var(--text-muted)' }}> by {finding.dismissed_by}</span>
        )}
        {finding.dismissal_reason && <> — {finding.dismissal_reason}</>}
        {' '}
        <button type="button" disabled={busy} onClick={() => onReinstate(finding.finding_id)}>
          Put it back
        </button>
      </p>
    )
  }

  if (!open) {
    return (
      <p style={{ margin: '8px 0 0' }}>
        <button type="button" disabled={busy} onClick={() => setOpen(true)}>
          I checked this — set it aside
        </button>
      </p>
    )
  }

  return (
    <form
      style={{ margin: '8px 0 0' }}
      onSubmit={(e) => {
        e.preventDefault()
        if (usable) {
          onDismiss(finding.finding_id, reason.trim())
          setOpen(false)
          setReason('')
        }
      }}
    >
      <label htmlFor={`dismiss-${finding.finding_id}`}
        style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        What did you check?
      </label>
      <p id={`dismiss-${finding.finding_id}-hint`}
        style={{ margin: '0 0 6px', color: 'var(--text-muted)', fontSize: 13 }}>
        The next reviewer reads this instead of repeating your work, and so does anyone asking
        later why this was not pursued.
      </p>
      <textarea
        id={`dismiss-${finding.finding_id}`}
        aria-describedby={`dismiss-${finding.finding_id}-hint`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{
          width: '100%', minHeight: 60, padding: '6px 8px', font: 'inherit',
          border: '1px solid var(--border)', borderRadius: 6,
          background: 'var(--surface)', color: 'var(--text)',
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button type="submit" disabled={busy || !usable}>Set aside</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {!usable && reason.length > 0 && (
        <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>
          A few more words — this is the record of why nobody pursued it.
        </p>
      )}
    </form>
  )
}
