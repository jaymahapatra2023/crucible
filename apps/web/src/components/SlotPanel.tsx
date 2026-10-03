import { useState } from 'react'
import type { SlotPlan, SlotStatus, TeamSlot } from '../lib/rosterApi.js'

/**
 * The floor plan: a slot per team, each with its room and coach, provisioned before anyone
 * arrives and claimed as teams register (migration 095).
 *
 * The primary signal is how many slots are still free, because that is the number that decides
 * whether the next team through the door has somewhere to sit. The pool running dry is not an
 * error — registration continues and the team is unplaced — so it is shown as a count to act on
 * rather than as a failure.
 */
export function SlotPanel({
  status, slots, plan, busy, failure, csv, onCsvChange, onPlan, onProvision,
}: {
  status: SlotStatus
  slots: readonly TeamSlot[]
  plan: SlotPlan | null
  busy: boolean
  failure: string | null
  csv: string
  onCsvChange: (next: string) => void
  onPlan: () => void
  /** Absent below organiser: the pool still reads (P8.2). */
  onProvision?: () => void
}) {
  const [showClaimed, setShowClaimed] = useState(false)
  const visible = showClaimed ? slots : slots.filter((s) => s.available)

  return (
    <section aria-labelledby="slots-heading">
      <h2 id="slots-heading" style={{ fontSize: 15 }}>The floor plan</h2>

      <p>
        <span data-testid="slots-available" style={{ fontSize: 28, fontWeight: 700 }}>
          {status.available}
        </span>
        <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
          of {status.total} slots still free · {status.claimed} claimed
        </span>
      </p>

      <PoolNotice status={status} />

      {slots.length > 0 && (
        <>
          <p style={{ fontSize: 13 }}>
            <label>
              <input type="checkbox" checked={showClaimed}
                onChange={(e) => setShowClaimed(e.target.checked)} /> show claimed slots too
            </label>
          </p>
          <div className="table-wrap">
            <table aria-label="Team slots">
              <thead>
                <tr>
                  <th scope="col">Slot</th><th scope="col">Room</th>
                  <th scope="col">Coach</th><th scope="col">Claimed by</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((slot) => (
                  <tr key={slot.team_id}>
                    <td>{slot.slot_label}</td>
                    <td>{slot.room_label ?? <span style={{ color: 'var(--warn)' }}>no room</span>}</td>
                    <td>{slot.coach_name ?? <span style={{ color: 'var(--warn)' }}>no coach</span>}</td>
                    <td>
                      {slot.available
                        ? <span style={{ color: 'var(--text-muted)' }}>free</span>
                        : slot.display_name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {onProvision && (
        <>
          <h3 style={{ fontSize: 13, marginTop: 18 }}>Provision slots</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 6px' }}>
            One row per team: <code>label,room,coach</code>. The room and the coach must already be
            on the roster. Checked before anything is written, and a file with any unusable row is
            refused whole. Uploading again adds new labels and leaves existing ones alone.
          </p>
          <textarea
            aria-label="Slots" value={csv} disabled={busy} rows={6}
            onChange={(e) => onCsvChange(e.target.value)}
            style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            placeholder={'label,room,coach\nTeam 1,Hall A,Margaret Hamilton'}
          />
          <p style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={busy || csv.trim() === ''} onClick={onPlan}>
              Check the file
            </button>
            {plan && plan.summary.invalid === 0 && plan.summary.new > 0 && (
              <button type="button" disabled={busy} onClick={onProvision}>
                Provision {plan.summary.new} new
              </button>
            )}
          </p>
          {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}
          {plan && <SlotPlanReport plan={plan} />}
        </>
      )}
    </section>
  )
}

/** What the pool's state means for the next team through the door. */
function PoolNotice({ status }: { status: SlotStatus }) {
  if (status.total === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        Nothing provisioned yet. Upload a file of <code>label,room,coach</code> below and every
        team that registers will take the next free slot, inheriting its room and coach.
      </p>
    )
  }
  return (
    <>
      {status.available === 0 && (
        <p role="status" style={{ color: 'var(--warn)' }}>
          Every slot is claimed. Teams can still register — they will simply have no room or coach
          until you place them, and they appear on the readiness list until you do.
        </p>
      )}
      {(status.withoutRoom > 0 || status.withoutCoach > 0) && (
        <p style={{ color: 'var(--warn)', fontSize: 13 }}>
          {status.withoutRoom > 0 && `${status.withoutRoom} slot(s) have no room. `}
          {status.withoutCoach > 0 && `${status.withoutCoach} slot(s) have no coach.`}
        </p>
      )}
    </>
  )
}

/** What the file would do, or did: counts, the rooms it fills, and every row that cannot be used. */
function SlotPlanReport({ plan }: { plan: SlotPlan }) {
  const unusable = plan.rows.filter((r) => r.outcome === 'INVALID')
  return (
    <div style={{ fontSize: 13 }}>
      <p role="status">
        {plan.provisioned ? 'Provisioned: ' : 'Would provision: '}
        {plan.summary.new} new, {plan.summary.existing} already there, {plan.summary.invalid} unusable.
      </p>
      {plan.refusal && <p role="alert" style={{ color: 'var(--danger)' }}>{plan.refusal}</p>}

      {plan.coachLoad.length > 0 && (
        <p>
          Teams per coach:{' '}
          {plan.coachLoad.map((c) => (
            <span key={c.coach} style={{ marginRight: 10 }}>
              {c.coach} {c.slots}
              {c.teamCapacity !== null && ` of ${c.teamCapacity}`}
              {/* Written out, never colour alone (P5.4). A coach handed a third team should
                  hear it from an organiser, not discover it on the day. */}
              {c.overTeamCapacity && (
                <strong style={{ color: 'var(--warn)' }}> over by {c.slots - (c.teamCapacity ?? 0)}</strong>
              )}
            </span>
          ))}
        </p>
      )}

      {plan.roomLoad.length > 0 && (
        <p>
          Teams per room:{' '}
          {plan.roomLoad.map((r) => (
            <span key={r.room} style={{ marginRight: 10 }}>
              {r.room} {r.slots}
              {r.teamCapacity !== null && ` of ${r.teamCapacity}`}
              {/* Written out, not marked by colour alone (P5.4). The room's TEAM limit is the
                  one that matters here; the seat count said nothing about this. */}
              {r.overTeamCapacity && (
                <strong style={{ color: 'var(--warn)' }}> over by {r.slots - (r.teamCapacity ?? 0)}</strong>
              )}
            </span>
          ))}
        </p>
      )}

      {unusable.length > 0 && (
        <div className="table-wrap">
          <table aria-label="Rows that cannot be used">
            <thead><tr><th scope="col">Line</th><th scope="col">Slot</th><th scope="col">Why</th></tr></thead>
            <tbody>
              {unusable.map((row) => (
                <tr key={row.line}>
                  <td>{row.line}</td><td>{row.label || '—'}</td><td>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
