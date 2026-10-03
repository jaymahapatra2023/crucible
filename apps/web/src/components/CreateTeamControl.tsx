import { useState } from 'react'
import type { Participant } from '../lib/rosterApi.js'

/**
 * Make a team without leaving the assignment surface (E28-S02 acceptance 7).
 *
 * A team that does not exist yet is the commonest reason an assignment cannot be made, and sending
 * the operator elsewhere to fix it costs the position they had in a list of two hundred names.
 *
 * The person currently at the top of the search is offered as the new team's first member, because
 * that is almost always why the team is being created at all — somebody was found who belongs on a
 * team that is not there. Taking them along also gives the team a contact address; created empty,
 * it has none, and the readiness checklist says so by name rather than the gap being invisible.
 */
export function CreateTeamControl({
  seed, busy, onCreate,
}: {
  /** The participant the operator was about to assign, offered as the first member. */
  seed: Participant | null
  busy: boolean
  onCreate: (displayName: string, participantId: number | null) => void
}) {
  const [name, setName] = useState('')
  const [withSeed, setWithSeed] = useState(true)

  const trimmed = name.trim()
  const ready = trimmed.length >= 2
  const take = seed !== null && withSeed

  function submit() {
    if (!ready) return
    onCreate(trimmed, take ? seed!.participantId : null)
    setName('')
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit() }}
      style={{ marginBottom: 10 }}
    >
      <label htmlFor="new-team-name" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Not there? Create a team
      </label>
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <input
          id="new-team-name" value={name} autoComplete="off" placeholder="Team name"
          onChange={(e) => setName(e.target.value)}
          style={{
            flex: 1, font: 'inherit', padding: '4px 8px', minWidth: 0,
            border: '1px solid var(--border)', borderRadius: 6,
          }}
        />
        <button type="submit" disabled={busy || !ready}>Create</button>
      </div>

      {seed !== null && (
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12,
        }}>
          <input type="checkbox" checked={withSeed}
            onChange={(e) => setWithSeed(e.target.checked)} />
          {/* Named, not counted: the operator has to be able to see WHO is coming along before
              the team is made, because this is also what sets the team's contact address. */}
          <span>
            with <strong>{seed.fullName}</strong> as its first member and point of contact
          </span>
        </label>
      )}

      {/* Stated rather than left to be discovered after the fact (P5.1). */}
      {!take && ready && (
        <p role="status" style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          {trimmed} will have nobody on it and no contact address until somebody is added.
        </p>
      )}
    </form>
  )
}
