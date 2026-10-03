import type { LinkPlan, LinkRow } from '../lib/calibrationApi.js'

/**
 * Connecting each ranked repository to the submission the machine scored (E21).
 *
 * The step that makes a report possible at all. Without it the gate has a human ordering and
 * nothing to compare it against, and refuses — with a message about the run rather than about
 * the missing link, which is a long way from the thing to fix.
 *
 * Checking writes nothing. It matches by canonical repository URL and says what it found, so an
 * organiser sees an entry nobody submitted BEFORE the report refuses rather than after.
 */
export function LinkEntries({
  plan, busy, onCheck, onLink,
}: {
  plan: LinkPlan | null
  busy: boolean
  onCheck: () => void
  onLink: () => void
}) {
  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 20,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Link entries to what was scored</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Each repository in this set has to be entered as a submission and scored by the same path
        as a real entry. This matches them up by repository URL. No report can be produced until
        every entry is linked.
      </p>

      <p style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" disabled={busy} onClick={onCheck}>
          {busy ? 'Working…' : 'Check what matches'}
        </button>
        {plan && !plan.linked && (
          <button type="button" disabled={busy || plan.summary.unresolved > 0} onClick={onLink}>
            Link {plan.summary.total} entr{plan.summary.total === 1 ? 'y' : 'ies'}
          </button>
        )}
        {plan && !plan.linked && plan.summary.unresolved > 0 && (
          <span style={{ color: 'var(--text-muted)' }}>
            {plan.summary.unresolved} still unresolved.
          </span>
        )}
      </p>

      {plan?.refusal && (
        <p role="alert" style={{ color: 'var(--danger)' }}>{plan.refusal}</p>
      )}

      {plan && (
        <>
          <p role="status" style={{ color: 'var(--text-muted)' }}>
            {plan.linked ? 'Linked' : 'Would link'} {plan.summary.resolved} of{' '}
            {plan.summary.total}.
            {plan.summary.unresolved > 0 && (
              <> The gate cannot be run until the rest are resolved.</>
            )}
          </p>
          <EntryTable rows={plan.rows} />
        </>
      )}
    </section>
  )
}

const TONE: Record<LinkOutcomeKey, string> = {
  MATCHED: 'var(--ok)',
  ALREADY_LINKED: 'var(--ok)',
  NO_SUBMISSION: 'var(--danger)',
  AMBIGUOUS: 'var(--danger)',
  UNREADABLE: 'var(--danger)',
}
type LinkOutcomeKey = LinkRow['outcome']

/** Every entry, resolved or not — "this one is fine" has to be visible too. */
function EntryTable({ rows }: { rows: LinkRow[] }) {
  return (
    <table aria-label="Entries in this set">
      <thead>
        <tr>
          <th scope="col">Entry</th><th scope="col">Repository</th>
          <th scope="col">Submission</th><th scope="col">State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.entryId}>
            <td>
              {row.label}
              {row.edgeCase && (
                <div style={{ color: 'var(--text-muted)' }}>{row.edgeCase.toLowerCase()}</div>
              )}
            </td>
            <td style={{ color: 'var(--text-muted)', wordBreak: 'break-all' }}>{row.repoUrl}</td>
            <td>
              {row.submissionId === null
                ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                : <>#{row.submissionId}{row.teamName && <> {row.teamName}</>}</>}
            </td>
            <td>
              {/* The word, not only the colour (P5.5). */}
              <span style={{ color: TONE[row.outcome], fontWeight: 600 }}>{label(row.outcome)}</span>
              {row.detail && <div style={{ color: 'var(--text-muted)' }}>{row.detail}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function label(outcome: LinkOutcomeKey): string {
  switch (outcome) {
    case 'MATCHED': return 'matched'
    case 'ALREADY_LINKED': return 'linked'
    case 'NO_SUBMISSION': return 'never submitted'
    case 'AMBIGUOUS': return 'more than one match'
    case 'UNREADABLE': return 'unusable URL'
  }
}
