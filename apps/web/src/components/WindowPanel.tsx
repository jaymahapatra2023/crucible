import { useState } from 'react'
import { FormField, TextInput } from './FormField.js'
import type { IntakeStatus } from '../lib/intakeApi.js'

/**
 * The submission window (E03-S04).
 *
 * Until one exists, intake reports NO_WINDOW and every team is refused — which is correct, and
 * is also the single most likely reason for a panicked message on the night. So the state is
 * stated here in the organiser's own terms, with the action that fixes it next to it.
 *
 * Locking is separated from closing and is deliberately harder. A closed window reopens by
 * moving its dates; a locked one does not reopen at all. That is the point — it is what makes
 * "the deadline has passed" mean something — so it asks for confirmation and says what it costs.
 */
export function WindowPanel({
  status, busy, onSave, onLock,
}: {
  status: IntakeStatus
  busy: boolean
  /** Absent below organiser: the panel then only reads (P8.2). */
  onSave?: (input: { name: string; opensAt: string; closesAt: string }) => void
  onLock?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const locked = status.state === 'LOCKED'
  const name = status.window?.name ?? 'Hackathon intake'
  const opensAt = toLocalInput(status.window?.opensAt)
  const closesAt = toLocalInput(status.window?.closesAt)

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 20,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Submission window</h2>

      {/* The page header already states whether intake is open, and repeats the message.
          Restating it here would duplicate a live region and say the same sentence twice; what
          the header does NOT give is the dates in a readable form, or the consequence of having
          no window at all. That is what this says. */}
      {status.window ? (
        <p style={{ marginTop: 0 }}>
          <strong>{status.window.name}</strong>
          <br />
          Opens {new Date(status.window.opensAt).toLocaleString()}
          {' · '}closes {new Date(status.window.closesAt).toLocaleString()}
          {locked && (
            <>
              <br />
              <span style={{ color: 'var(--danger)' }}>
                Locked {new Date(status.window.lockedAt ?? '').toLocaleString()}. No further
                entry, correction or resubmission can be accepted.
              </span>
            </>
          )}
        </p>
      ) : (
        <p style={{ marginTop: 0, color: 'var(--warn)' }}>
          There is no submission window, so <strong>no team can submit</strong>. Set one before
          you send out invitations.
        </p>
      )}

      <Controls locked={locked} editing={editing} busy={busy} initial={{ name, opensAt, closesAt }}
        hasWindow={status.window !== null} setEditing={setEditing} {...(onSave && { onSave })} {...(onLock && { onLock })} />
    </section>
  )
}

/**
 * The window's dates.
 *
 * Its own component so the panel above stays about the STATE of intake and this stays about
 * editing it — and so the ordering check has one obvious home.
 */
function WindowForm({
  initial, busy, onCancel, onSave,
}: {
  initial: { name: string; opensAt: string; closesAt: string }
  busy: boolean
  onCancel: () => void
  onSave: (input: { name: string; opensAt: string; closesAt: string }) => void
}) {
  const [name, setName] = useState(initial.name)
  const [opensAt, setOpensAt] = useState(initial.opensAt)
  const [closesAt, setClosesAt] = useState(initial.closesAt)
  const bothSet = opensAt !== '' && closesAt !== ''
  const ordered = bothSet && closesAt > opensAt

  return (
    <form onSubmit={(e) => {
      e.preventDefault()
      if (ordered) {
        onSave({
          name,
          opensAt: new Date(opensAt).toISOString(),
          closesAt: new Date(closesAt).toISOString(),
        })
      }
    }}>
      <FormField id="w-name" label="Name" required>
        <TextInput id="w-name" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <FormField id="w-opens" label="Opens" required>
          <TextInput id="w-opens" type="datetime-local" value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)} />
        </FormField>
        <FormField id="w-closes" label="Closes" required
          error={bothSet && !ordered ? 'The window must close after it opens.' : null}>
          <TextInput id="w-closes" type="datetime-local" value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)} />
        </FormField>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !ordered}>Save window</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

/**
 * Locking intake.
 *
 * Separated from closing and deliberately harder. A closed window reopens by moving its dates;
 * a locked one does not reopen at all. That is the point — it is what makes "the deadline has
 * passed" mean something — so it asks for confirmation and names what it costs.
 */
function Controls({ locked, editing, busy, initial, hasWindow, setEditing, onSave, onLock }: {
  locked: boolean; editing: boolean; busy: boolean
  initial: { name: string; opensAt: string; closesAt: string }; hasWindow: boolean
  setEditing: (v: boolean) => void
  onSave?: (input: { name: string; opensAt: string; closesAt: string }) => void
  onLock?: () => void
}) {
  if (locked) return null
  return (
    <>
      {onSave && !editing && (
        <button type="button" onClick={() => setEditing(true)} disabled={busy}>
          {hasWindow ? 'Change the window' : 'Set the window'}
        </button>
      )}
      {onSave && editing && (
        <WindowForm
          initial={initial} busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(input) => { onSave(input); setEditing(false) }}
        />
      )}
      {onLock && hasWindow && <LockControl busy={busy} onLock={onLock} />}
    </>
  )
}

function LockControl({ busy, onLock }: { busy: boolean; onLock: () => void }) {
  return (
    <p style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <button type="button" disabled={busy}
        onClick={() => {
          if (globalThis.confirm(
            'Locking intake is permanent. No further entry, correction or resubmission can be '
            + 'accepted — including from a team whose repository turned out to be private. '
            + 'Lock now?')) onLock()
        }}>
        Lock intake permanently
      </button>
      <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
        This cannot be undone. Closing the window by date is reversible; locking is not.
      </span>
    </p>
  )
}

/** An ISO instant as a `datetime-local` value, in the organiser's own timezone. */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
