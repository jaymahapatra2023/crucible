/**
 * Recording a decision about one team (E08-S04).
 *
 * The one screen in Crucible where a person decides rather than reads. Three things it insists
 * on, each because of what this record is for:
 *
 *  - The reason is mandatory, and the form says what it will be used for rather than just
 *    marking the field required.
 *  - An existing decision is shown with its author before it can be changed, so an override is
 *    never replaced by someone who did not know it was there.
 *  - A finalised shortlist disables the control and says why, rather than accepting input the
 *    server will refuse.
 */
import { useState } from 'react'
import type { DecisionHistoryEntry, ShortlistDecision } from '../lib/reviewApi.js'

export type Decision = 'SHORTLIST' | 'EXCLUDE' | 'HOLD'

const OPTIONS: Array<{ value: Decision; label: string; help: string }> = [
  { value: 'SHORTLIST', label: 'Shortlist', help: 'This team presents.' },
  { value: 'EXCLUDE', label: 'Exclude', help: 'This team does not present.' },
  { value: 'HOLD', label: 'Hold', help: 'Looked at, not decided. Blocks finalising.' },
]

export function DecisionPanel({
  existing, history = [], locked, busy, onDecide,
}: {
  existing: ShortlistDecision | null
  /** Every decision taken about this team, newest first. Empty until one has been. */
  history?: readonly DecisionHistoryEntry[]
  locked: boolean
  busy?: boolean
  onDecide: (decision: Decision, reason: string) => void
}) {
  const [decision, setDecision] = useState<Decision>(existing?.decision ?? 'SHORTLIST')
  const [reason, setReason] = useState('')
  const tooShort = reason.trim().length < 10

  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Decision</h2>

      {existing && (
        <p data-testid="existing-decision" style={{ fontSize: 13, margin: '0 0 8px' }}>
          <strong>{existing.decision}</strong> by {existing.decided_by}
          {existing.rank_at_decision !== null && ` at rank ${existing.rank_at_decision}`}
          {' — '}
          {existing.reason}
        </p>
      )}

      <History entries={history} />

      {locked ? (
        <p role="status" style={{ fontSize: 13, color: 'var(--warn)', margin: 0 }}>
          This shortlist is final, so its decisions cannot be changed. Reopening it is possible
          and is itself recorded.
        </p>
      ) : (
        <>
          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 8px' }}>
            <legend style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {existing ? 'Change the decision' : 'What happens to this team?'}
            </legend>
            {OPTIONS.map((option) => (
              <label key={option.value} style={{ display: 'block', fontSize: 13, marginTop: 4 }}>
                <input
                  type="radio"
                  name="decision"
                  value={option.value}
                  checked={decision === option.value}
                  onChange={() => setDecision(option.value)}
                />{' '}
                {option.label}
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {' '}— {option.help}
                </span>
              </label>
            ))}
          </fieldset>

          <label style={{ fontSize: 12, display: 'block' }}>
            Reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={{ width: '100%', font: 'inherit', fontSize: 13, marginTop: 4 }}
            />
          </label>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 8px' }}>
            Recorded with your name and the team’s rank. If they appeal, this is the answer.
          </p>

          <button
            type="button"
            disabled={tooShort || busy === true}
            onClick={() => onDecide(decision, reason.trim())}
            style={{
              border: '1px solid var(--border)', background: 'var(--surface)',
              borderRadius: 6, padding: '6px 12px', cursor: tooShort ? 'not-allowed' : 'pointer',
              font: 'inherit',
            }}
          >
            {existing ? 'Change decision' : 'Record decision'}
          </button>
          {tooShort && reason.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--warn)', marginLeft: 8 }}>
              A few more words, please — at least ten characters.
            </span>
          )}
        </>
      )}
    </section>
  )
}

/**
 * What this team was moved from, and by whom.
 *
 * Shown beside the control that would move them again. A person about to change a decision is
 * exactly the person who should see that it has already been changed twice — the record exists
 * to answer an appeal, and so does this.
 *
 * Only the superseded entries: the one that stands is already stated above, and repeating it
 * here would read as though the team had been decided twice over.
 */
function History({ entries }: { entries: readonly DecisionHistoryEntry[] }) {
  const earlier = entries.filter((e) => e.superseded_at !== null)
  if (earlier.length === 0) return null

  return (
    <details data-testid="decision-history" style={{ fontSize: 12, margin: '0 0 8px' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
        Moved {earlier.length === 1 ? 'once' : `${earlier.length} times`} before this
      </summary>
      <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {earlier.map((entry) => (
          <li key={entry.id} style={{ marginTop: 4 }}>
            <strong>{entry.decision}</strong> by {entry.decided_by}
            {' on '}{new Date(entry.decided_at).toLocaleDateString()}
            <div style={{ color: 'var(--text-muted)' }}>{entry.reason}</div>
          </li>
        ))}
      </ol>
    </details>
  )
}
