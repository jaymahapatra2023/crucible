import type { ArrivalSummary } from '../lib/arrivalApi.js'

/**
 * Which coaches are here, and how many teams have nobody (migration 105).
 *
 * The headline number is TEAMS UNCOVERED, not coaches missing, because those are different
 * numbers and only one of them is actionable. Fourteen of the thirty-four coaches take two teams
 * each, so three absentees can mean anything from three teams to six, and an organiser deciding
 * who to redeploy at 9am needs the figure that counts teams.
 *
 * Missing coaches sort first, because the list exists to be worked through rather than read.
 */
export function ArrivalPanel({ state, busy, onRefresh }: {
  state: ArrivalSummary | null
  busy: boolean
  onRefresh: () => void
}) {
  const missing = (state?.coaches ?? []).filter((c) => !c.arrived)

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 15 }}>Coaches at the venue</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 8px' }}>
        Coaches mark themselves here from the public “Coaches” page.
      </p>

      <button type="button" disabled={busy} onClick={onRefresh}>Refresh</button>

      {state && (
        <>
          <p style={{ margin: '10px 0 4px' }}>
            {/* The number to act on, and it is not the count of missing people. */}
            <span data-testid="teams-uncovered" style={{ fontSize: 28, fontWeight: 700 }}>
              {state.summary.teamsUncovered}
            </span>
            <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
              teams have no coach here yet · {state.summary.arrived} of {state.summary.total}{' '}
              coaches confirmed
            </span>
          </p>

          {missing.length === 0 ? (
            <p style={{ color: 'var(--ok)' }}>Every coach has confirmed.</p>
          ) : (
            <div className="table-wrap">
              <table aria-label="Coaches who have not confirmed">
                <thead>
                  <tr>
                    <th scope="col">Coach</th>
                    <th scope="col">Teams left without one</th>
                    <th scope="col">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {missing.map((c) => (
                    <tr key={c.coachId}>
                      <td>{c.fullName}</td>
                      <td>
                        {/* Written out, never a colour alone (P5.4). */}
                        {c.teamsUncovered === 0
                          ? <span style={{ color: 'var(--text-muted)' }}>none assigned yet</span>
                          : <strong style={{ color: 'var(--warn)' }}>{c.teamsUncovered}</strong>}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
