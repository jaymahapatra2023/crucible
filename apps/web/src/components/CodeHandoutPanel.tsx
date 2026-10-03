import type { HandoutPlan } from '../lib/codeHandoutApi.js'

/**
 * Sending every registered team its submission code, once (migration 103).
 *
 * Separate from registration on purpose: a team registers before coding starts, when a code is
 * of no use to them, and a code emailed at 9am sits in every inbox all day before anybody needs
 * it. The organiser presses this mid-afternoon, once teams are settled.
 *
 * Two steps, like every other bulk path here: see what would go, then send it. The counts are
 * the primary signal, and WAITING is the one that means there is work to do.
 */
export function CodeHandoutPanel({
  plan, busy, canSend, onCheck, onSend,
}: {
  plan: HandoutPlan | null
  busy: boolean
  /** False below organiser: the counts still read, nothing sends. */
  canSend: boolean
  onCheck: () => void
  onSend: () => void
}) {
  const waiting = plan?.summary.waiting ?? 0

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 15 }}>Send the submission codes</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 8px' }}>
        Registration tells a team their room and coach. This tells them their code, how to submit
        and by when. Safe to press twice: a team already sent its code is not sent it again.
      </p>

      <button type="button" disabled={busy} onClick={onCheck}>
        Check who is waiting
      </button>

      {plan && (
        <>
          <p style={{ margin: '10px 0 4px' }}>
            <span data-testid="handout-waiting" style={{ fontSize: 28, fontWeight: 700 }}>
              {waiting}
            </span>
            <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
              of {plan.summary.total} registered teams have not been sent their code
              {plan.summary.alreadySent > 0 && ` · ${plan.summary.alreadySent} already have`}
              {plan.summary.blocked > 0 && ` · ${plan.summary.blocked} cannot be sent`}
            </span>
          </p>

          {/* Written out, never a colour alone (P5.4). A blocked team needs a human. */}
          {plan.rows.some((r) => r.state === 'BLOCKED') && (
            <ul aria-label="Teams that cannot be sent a code" style={{ fontSize: 13, paddingLeft: 18 }}>
              {plan.rows.filter((r) => r.state === 'BLOCKED').map((r) => (
                <li key={r.teamId}>
                  <strong>{r.teamName}</strong> — {r.detail}
                </li>
              ))}
            </ul>
          )}

          {canSend && (
            <button type="button" disabled={busy || waiting === 0} onClick={onSend}>
              {waiting === 0 ? 'Nothing waiting' : `Send to ${waiting} team${waiting === 1 ? '' : 's'}`}
            </button>
          )}

          {plan.report && (
            <p role="status" style={{ fontSize: 13 }}>
              Sent {plan.report.outcomes.filter((o) => o.status === 'SENT').length}
              {', '}
              failed {plan.report.outcomes.filter((o) => o.status === 'FAILED').length}
              {'. '}
              {plan.report.sends
                ? 'Delivery is recorded against each team.'
                : 'The configured adapter composes but does not transmit, so nothing left this machine.'}
            </p>
          )}
        </>
      )}
    </section>
  )
}
