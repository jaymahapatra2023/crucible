import type { Correction } from '../lib/confirmApi.js'

/**
 * Claims waiting for an organiser (migration 104).
 *
 * Each row says plainly what pressing the button would DO, because the two cases are different
 * acts: correcting somebody already on the list, or adding somebody who never was. A row that
 * only showed a name and an address would leave the organiser to work that out themselves,
 * twenty times, at a desk, while people wait.
 *
 * The before and the after sit next to each other for the same reason. Approving rewrites the
 * address a team's submission code will go to, so the person pressing should see exactly what
 * they are changing it from.
 */
export function CorrectionQueue({
  corrections, busy, canDecide, onDecide,
}: {
  corrections: readonly Correction[]
  busy: boolean
  /** False below organiser: the queue still reads, nothing is decided. */
  canDecide: boolean
  onDecide: (correctionId: number, approve: boolean) => void
}) {
  const pending = corrections.filter((c) => c.status === 'PENDING')

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 15 }}>Details people have sent in</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 8px' }}>
        From the public “Check your details” page. Nothing here has been applied yet.
      </p>

      {pending.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>Nothing waiting.</p>
      ) : (
        <>
          <p style={{ margin: '0 0 8px' }}>
            <span data-testid="corrections-waiting" style={{ fontSize: 28, fontWeight: 700 }}>
              {pending.length}
            </span>
            <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
              waiting · {pending.filter((c) => c.kind === 'ADD').length} to add
              {' · '}
              {pending.filter((c) => c.kind === 'CORRECTION').length} to correct
            </span>
          </p>

          <div className="table-wrap">
            <table aria-label="Details people have sent in">
              <thead>
                <tr>
                  <th scope="col">What this would do</th>
                  <th scope="col">They say</th>
                  <th scope="col">We hold</th>
                  <th scope="col"><span className="sr-only">Decision</span></th>
                </tr>
              </thead>
              <tbody>
                {pending.map((c) => (
                  <tr key={c.correctionId}>
                    <td>
                      {/* Written out, never implied by a colour (P5.4). */}
                      <strong>{c.kind === 'ADD' ? 'Add a new person' : 'Correct their details'}</strong>
                      {c.onATeam && (
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--warn)' }}>
                          Already on a team — their team’s emails will follow the new address.
                        </span>
                      )}
                    </td>
                    <td>
                      {c.claimedName}
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                        {c.claimedEmail}
                      </span>
                    </td>
                    <td>
                      {c.currentName ?? <span style={{ color: 'var(--text-muted)' }}>nobody of that name</span>}
                      {c.currentEmail !== null && (
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                          {c.currentEmail}
                        </span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canDecide && (
                        <>
                          <button type="button" disabled={busy}
                            onClick={() => onDecide(c.correctionId, true)}>
                            {c.kind === 'ADD' ? 'Add' : 'Apply'}
                          </button>
                          {' '}
                          <button type="button" disabled={busy}
                            onClick={() => onDecide(c.correctionId, false)}>
                            Dismiss
                          </button>
                        </>
                      )}
                    </td>
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
