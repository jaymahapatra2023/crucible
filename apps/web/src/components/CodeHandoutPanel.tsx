import { useState } from 'react'
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
 *
 * It reports PEOPLE as well as teams, because the first run of this at the event sent thirty
 * messages to thirty readers and left eighty-six team members without the code. "30 teams" read
 * as success; "30 people" would not have.
 */
/**
 * Who the send actually reaches, in people and by name.
 *
 * Its own component because the panel is otherwise past its complexity budget, and because this
 * is the part worth reading on its own: a team with no teammate address is named, not counted.
 */
function Reach({ sending, people }: {
  sending: ReadonlyArray<{ teamId: number; teamName: string; copiedTo: number }>
  people: number
}) {
  if (sending.length === 0) return null
  const alone = sending.filter((r) => r.copiedTo === 0)

  return (
    <>
      <p data-testid="handout-people" style={{ fontSize: 13, margin: '0 0 8px' }}>
        That reaches <strong>{people} people</strong> — the registrant on each team plus every
        teammate with an address, copied on the same message.
      </p>

      {/* Named in words, because a team whose code reaches one inbox is the failure this panel
          exists to make visible, and a count alone would not say which team. */}
      {alone.length > 0 && (
        <ul
          aria-label="Teams where the code reaches only one person"
          style={{ fontSize: 13, paddingLeft: 18 }}
        >
          {alone.map((r) => (
            <li key={r.teamId}>
              <strong>{r.teamName}</strong> — no teammate has an address on the roster, so the
              code reaches one person. Add the rest of the team on the roster first.
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * Teams that cannot be sent a code at all, named with the reason.
 *
 * Written out, never a colour alone (P5.4). A blocked team needs a person to act, so it has to
 * read as a sentence somebody can follow.
 */
function Blocked({ rows }: { rows: HandoutPlan['rows'] }) {
  const blocked = rows.filter((r) => r.state === 'BLOCKED')
  if (blocked.length === 0) return null

  return (
    <ul aria-label="Teams that cannot be sent a code" style={{ fontSize: 13, paddingLeft: 18 }}>
      {blocked.map((r) => (
        <li key={r.teamId}><strong>{r.teamName}</strong> — {r.detail}</li>
      ))}
    </ul>
  )
}

/** What actually happened, once something was sent. Null until it was. */
function Outcome({ report }: { report: HandoutPlan['report'] }) {
  if (!report) return null
  const count = (status: string) => report.outcomes.filter((o) => o.status === status).length

  return (
    <p role="status" style={{ fontSize: 13 }}>
      Sent {count('SENT')}, failed {count('FAILED')}.{' '}
      {report.sends
        ? 'Delivery is recorded against each team.'
        : 'The configured adapter composes but does not transmit, so nothing left this machine.'}
    </p>
  )
}

export function CodeHandoutPanel({
  plan, busy, canSend, onCheck, onSend,
}: {
  plan: HandoutPlan | null
  busy: boolean
  /** False below organiser: the counts still read, nothing sends. */
  canSend: boolean
  onCheck: (resend: boolean) => void
  onSend: (resend: boolean) => void
}) {
  const [resend, setResend] = useState(false)
  const waiting = plan?.summary.waiting ?? 0
  const sending = plan?.rows.filter((r) => r.state === 'WAITING') ?? []
  const people = sending.reduce((n, r) => n + 1 + r.copiedTo, 0)

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 15 }}>Send the submission codes</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 8px' }}>
        Registration tells a team their room and coach. This tells them their code, how to submit
        and by when. Safe to press twice: a team already sent its code is not sent it again.
      </p>

      <button type="button" disabled={busy} onClick={() => onCheck(resend)}>
        Check who is waiting
      </button>

      {canSend && (
        <label style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
          <input
            type="checkbox" checked={resend} disabled={busy}
            onChange={(e) => setResend(e.target.checked)}
          />{' '}
          Send again to teams already sent — use this only to correct a send that reached the
          wrong people. Asking twice still sends one message.
        </label>
      )}

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

          <Reach sending={sending} people={people} />
          <Blocked rows={plan.rows} />

          {canSend && (
            <button type="button" disabled={busy || waiting === 0} onClick={() => onSend(resend)}>
              {waiting === 0
                ? 'Nothing waiting'
                : `Send to ${waiting} team${waiting === 1 ? '' : 's'}`
                  + (sending.length > 0 ? ` · ${people} people` : '')}
            </button>
          )}

          <Outcome report={plan.report} />
        </>
      )}
    </section>
  )
}
