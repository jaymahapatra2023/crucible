import type { TeamToChase } from '../lib/reminderApi.js'

/**
 * Who is not there yet, and the button that tells them (E50).
 *
 * Two kinds of team an organiser must see before the deadline: registered but nothing
 * submitted, and submitted with problems the checks found that have not been fixed. Each row
 * says which, when they were last reminded and by what channel, so nobody is nagged twice by
 * accident — and the deadline itself is not the first time anybody hears.
 */
export function ChasePanel({
  teams, busy, onRemind,
}: {
  teams: readonly TeamToChase[]
  busy: boolean
  /** Absent for a reader who cannot send. */
  onRemind?: (teamIds?: number[]) => void
}) {
  const notSubmitted = teams.filter((t) => t.kind === 'NOT_SUBMITTED')
  const problems = teams.filter((t) => t.kind === 'PROBLEMS')

  return (
    <section style={{ marginTop: 24 }} aria-labelledby="chase-heading">
      <h2 id="chase-heading" style={{ fontSize: 15 }}>
        Not there yet{' '}
        <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
          ({notSubmitted.length} not submitted · {problems.length} with problems)
        </span>
      </h2>

      {teams.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }} data-testid="chase-empty">
          Every registered team has submitted and nothing is outstanding.
        </p>
      ) : (
        <>
          {onRemind && (
            <p>
              <button type="button" disabled={busy} onClick={() => onRemind()}>
                Remind all {teams.length}
              </button>
            </p>
          )}
          <div className="table-wrap">
            <table aria-label="Not there yet">
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  <th scope="col">Why</th>
                  <th scope="col">Last reminded</th>
                  {onRemind && <th scope="col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.teamId}>
                    <td>
                      {t.teamName}
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {' '}· {t.hasDiscord ? 'Discord, then email' : 'email'}
                      </span>
                    </td>
                    <td>{t.situation}</td>
                    <td><LastReminder r={t.lastReminder} /></td>
                    {onRemind && (
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" disabled={busy} onClick={() => onRemind([t.teamId])}>Remind</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function LastReminder({ r }: { r: TeamToChase['lastReminder'] }) {
  if (r === null) return <span style={{ color: 'var(--text-muted)' }}>never</span>
  const when = new Date(r.sentAt).toLocaleString()
  if (r.status === 'FAILED') return <span style={{ color: 'var(--danger)' }}>failed {when}{r.detail ? ` — ${r.detail}` : ''}</span>
  return <>{r.status === 'SENT' ? 'sent' : 'prepared'} by {r.channel} {when}{r.detail ? ` (${r.detail})` : ''}</>
}
