import type { DeliveryReport, TeamDelivery } from '../lib/intakeApi.js'

/**
 * Whether each team actually got what it needs to submit (E29-S02, E34).
 *
 * The gap this closes is a silent one: a team that never received its code does not complain, it
 * simply fails to enter, and nobody finds out until the deadline has passed. So the primary
 * signal is the count of teams **not** reached, not the count of messages sent.
 *
 * `NONE` is shown as its own state rather than folded into a failure. Nothing was attempted for
 * that team, which is a different problem with a different fix (P5.1).
 */
export function DeliveryPanel({
  state, report, busy, onPrepare, onDownload,
}: {
  state: readonly TeamDelivery[]
  /** The result of the issue that just happened. Null on a page that has not issued. */
  report: DeliveryReport | null
  busy: boolean
  /** Absent below organiser: the count still reads, nothing sends. */
  onPrepare?: () => void
  onDownload: () => void
}) {
  const reached = state.filter((t) => t.status === 'SENT' || t.status === 'PREPARED')
  const outstanding = state.filter((t) => t.status !== 'SENT' && t.status !== 'PREPARED')

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 15 }}>Getting teams their code</h2>

      {state.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          No teams yet, so there is nothing to send.
        </p>
      ) : (
        <p>
          {/* The number that says whether the job is done, and it counts the failures. */}
          <span data-testid="unreached-count" style={{ fontSize: 28, fontWeight: 700 }}>
            {outstanding.length}
          </span>
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
            of {state.length} teams have not been sent a code
            {reached.length > 0 && ` · ${reached.length} have`}
          </span>
        </p>
      )}

      {report && <ReportSummary report={report} busy={busy} onDownload={onDownload} />}

      {/* Collapsed, because the primary signal is who was NOT reached. Opened when a team says
          "we never got it": the provider's own reference is what support quotes back.
          The channel is named here too (migration 100) — a team CAN be reached and still have
          had its DM refused, and that team is invisible in the outstanding table below. */}
      {reached.length > 0 && (
        <details style={{ margin: '8px 0', fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
            {reached.length} sent or prepared
          </summary>
          <ul aria-label="Teams sent a code" style={{ paddingLeft: 18, margin: '6px 0 0' }}>
            {reached.map((t) => (
              <li key={t.teamId}>
                {t.teamName} · {t.status} · <Channel team={t} />
                {t.providerRef !== null && (
                  <span style={{ color: 'var(--text-muted)' }}> · ref <code>{t.providerRef}</code></span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {onPrepare && (
        <button type="button" disabled={busy || state.length === 0} onClick={onPrepare}>
          Issue and send to every team without a code
        </button>
      )}

      {outstanding.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }}>
          <caption className="sr-only">Teams that have not been sent a code</caption>
          <thead>
            <tr>
              <th scope="col" style={HEAD}>Team</th>
              <th scope="col" style={HEAD}>Contact</th>
              <th scope="col" style={HEAD}>Channel</th>
              <th scope="col" style={HEAD}>State</th>
              <th scope="col" style={HEAD}>What went wrong</th>
            </tr>
          </thead>
          <tbody>
            {outstanding.map((team) => (
              <tr key={team.teamId}>
                <td style={CELL}>{team.teamName}</td>
                <td style={CELL}>
                  {team.contactEmail.trim() === ''
                    ? <span style={{ color: 'var(--danger)' }}>no address</span>
                    : team.contactEmail}
                </td>
                <td style={CELL}><Channel team={team} /></td>
                {/* Written out, never colour alone (P5.4). */}
                <td style={CELL}>{team.status === 'NONE' ? 'Not attempted' : team.status}</td>
                <td style={CELL}>{team.lastError ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * What the issue that just ran actually did.
 *
 * The download is offered ONCE, here, because the messages contain the tokens and the tokens
 * exist only in this response. Refreshing the page loses them, exactly as it loses the tokens
 * themselves — there is no second copy anywhere by design.
 */
function ReportSummary({
  report, busy, onDownload,
}: {
  report: DeliveryReport
  busy: boolean
  onDownload: () => void
}) {
  const failed = report.outcomes.filter((o) => o.status === 'FAILED')

  return (
    <div style={{
      border: `1px solid ${failed.length > 0 ? 'var(--warn)' : 'var(--border)'}`,
      borderRadius: 8, padding: 10, margin: '10px 0',
    }}>
      <p style={{ margin: 0, fontSize: 13 }}>
        {report.sends
          ? `Sent through ${report.provider}.`
          : `No mail provider is configured, so nothing was sent. `
            + `${report.messages.length} message(s) were composed for you to send.`}
        {failed.length > 0 && ` ${failed.length} could not be prepared.`}
      </p>

      {report.messages.length > 0 && (
        <>
          <button type="button" disabled={busy} onClick={onDownload}
            style={{ marginTop: 8 }}>
            Download the {report.messages.length} message(s)
          </button>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--danger)' }}>
            These contain the codes and exist only on this screen. Leaving the page loses them,
            and they cannot be produced again — issuing a new code is the only way back.
          </p>
        </>
      )}

      {failed.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
          {failed.map((o) => <li key={o.teamId}><strong>{o.teamName}</strong> — {o.detail}</li>)}
        </ul>
      )}
    </div>
  )
}

const HEAD: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px', borderBottom: '2px solid var(--border)',
  fontSize: 12, color: 'var(--text-muted)',
}
const CELL: React.CSSProperties = {
  padding: '4px 8px', borderBottom: '1px solid var(--border)',
}

/**
 * How the team was reached (migration 100).
 *
 * 'both' is the ordinary outcome for a team with a Discord contact, so it is stated plainly and
 * not marked. The cases an organiser must act on are the partial ones: a Discord contact reached
 * by email ALONE means the DM was refused, and email alone failing means nothing arrived. Each
 * says which, in words, never by colour alone (P5.4).
 */
function Channel({ team }: { team: TeamDelivery }) {
  if (team.channel === 'both') return <>Discord DM and email</>
  if (team.channel === 'discord') {
    return team.hasDiscord
      ? <>Discord DM <span style={{ color: 'var(--warn)' }}>(email did not go)</span></>
      : <>Discord DM</>
  }
  if (team.channel === 'email') {
    return team.hasDiscord
      ? <>Email <span style={{ color: 'var(--warn)' }}>(Discord refused)</span></>
      : <>Email</>
  }
  return <span style={{ color: 'var(--text-muted)' }}>{team.hasDiscord ? 'Discord and email' : 'Email'}</span>
}
