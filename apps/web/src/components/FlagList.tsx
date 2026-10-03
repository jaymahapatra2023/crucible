/**
 * Every automated caveat on one submission (E08-S03).
 *
 * The API sends each flag's wording, so nothing here translates a code into a sentence — a
 * second vocabulary in the browser would drift from the one in the export and the audit log.
 *
 * Dismissal takes a reason and will not proceed without one. The control says why rather than
 * merely refusing: a reviewer who is told "required" types anything, and a reviewer who is told
 * what the reason is for writes something an appeal can use.
 */
import { useState } from 'react'
import type { ReviewFlag } from '../lib/reviewApi.js'

export function FlagList({
  flags, onDismiss, busy,
}: {
  flags: ReviewFlag[]
  onDismiss?: (code: string, reason: string) => void
  busy?: boolean
}) {
  const open = flags.filter((f) => !f.dismissed)
  const dismissed = flags.filter((f) => f.dismissed)

  if (flags.length === 0) {
    return (
      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        No automated caveats were raised for this submission.
      </p>
    )
  }

  return (
    <section>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>
        Caveats — {open.length} open
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        Things the system could not resolve on its own. None of them excludes anyone.
      </p>

      {open.map((flag) => (
        <FlagCard
          key={flag.code}
          flag={flag}
          {...(onDismiss && { onDismiss })}
          {...(busy !== undefined && { busy })}
        />
      ))}

      {dismissed.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12, cursor: 'pointer' }}>
            {dismissed.length} dismissed
          </summary>
          {dismissed.map((flag) => (
            <article key={flag.code} style={{ ...card, opacity: 0.75 }}>
              <strong style={{ fontSize: 13 }}>{flag.message}</strong>
              <p style={{ fontSize: 12, margin: '6px 0 0', color: 'var(--text-muted)' }}>
                Dismissed by {flag.dismissed_by}: {flag.dismissal_reason}
              </p>
            </article>
          ))}
        </details>
      )}
    </section>
  )
}

function FlagCard({
  flag, onDismiss, busy,
}: {
  flag: ReviewFlag
  onDismiss?: (code: string, reason: string) => void
  busy?: boolean
}) {
  const [reason, setReason] = useState('')
  const [showForm, setShowForm] = useState(false)
  const tooShort = reason.trim().length < 10

  return (
    <article
      data-testid={`flag-${flag.code}`}
      style={{
        ...card,
        borderColor: flag.severity === 'ATTENTION' ? 'var(--warn)' : 'var(--border)',
      }}
    >
      <p style={{ fontSize: 13, margin: 0 }}>{flag.message}</p>

      {onDismiss && !showForm && (
        <button type="button" style={linkButton} onClick={() => setShowForm(true)}>
          Dismiss this caveat
        </button>
      )}

      {onDismiss && showForm && (
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12, display: 'block' }}>
            Why can this be set aside?
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              style={{ width: '100%', font: 'inherit', fontSize: 13, marginTop: 4 }}
            />
          </label>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 6px' }}>
            Recorded against this submission. If a team appeals, this is the answer to “why was
            this ignored?”
          </p>
          <button
            type="button"
            disabled={tooShort || busy === true}
            onClick={() => onDismiss(flag.code, reason.trim())}
            style={button}
          >
            Dismiss
          </button>
          <button type="button" style={linkButton} onClick={() => setShowForm(false)}>
            Cancel
          </button>
          {tooShort && reason.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--warn)', marginLeft: 8 }}>
              A few more words, please — at least ten characters.
            </span>
          )}
        </div>
      )}
    </article>
  )
}

const card = {
  border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 8,
} as const

const button = {
  border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', font: 'inherit', fontSize: 13,
} as const

const linkButton = {
  border: 'none', background: 'none', color: 'var(--text-muted)',
  cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '4px 6px',
} as const
