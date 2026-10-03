import { useState } from 'react'
import { TextInput } from './FormField.js'
import type { Participant } from '../lib/rosterApi.js'

/** Why somebody is being taken off the roster. A removal without one is not a record (P7.4). */
export const REMOVAL_REASONS = [
  { value: 'USER_REQUEST', label: 'They asked to be removed' },
  { value: 'ADMIN_ACTION', label: 'An organiser decided' },
  { value: 'GDPR_ERASURE', label: 'Erasure request' },
  { value: 'DEDUP', label: 'Duplicate record' },
] as const

/**
 * One participant, editable in place (E27-S01 acceptance 4, surfaced in E31).
 *
 * Editing happens in the row rather than on a page of its own, because the corrections this gets
 * used for — a misspelt name, a typo in an address — are found while reading the list, and making
 * the operator navigate away and back loses the place they had in two hundred rows.
 *
 * Removal asks for a reason and does not ask twice. The reason is the record: a participant who
 * vanished with no statement of why is the gap P7.4 exists to prevent, and a confirm dialogue on
 * top of a required reason would be ceremony rather than safety.
 */
export function ParticipantRow({
  person, busy, onSave, onRemove,
}: {
  person: Participant
  busy: boolean
  onSave: (changes: Partial<Participant>) => void
  onRemove: (reason: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [draft, setDraft] = useState(person)

  function begin() {
    setDraft(person)
    setEditing(true)
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={6} style={{ padding: 8, background: 'var(--sunk, transparent)' }}>
          <form
            // Named, so anyone tabbing into it hears WHOSE record they are editing rather than
            // landing in an unlabelled cluster of inputs identical to the add form above.
            aria-label={`Edit ${person.fullName}`}
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}
            onSubmit={(e) => {
              e.preventDefault()
              setEditing(false)
              onSave({
                fullName: draft.fullName, email: draft.email,
                organisation: draft.organisation === '' ? null : draft.organisation,
                phone: draft.phone === '' ? null : draft.phone,
                discordUsername: (draft.discordUsername ?? '') === '' ? null : draft.discordUsername,
              })
            }}
          >
            <TextInput aria-label="Full name" value={draft.fullName} style={{ width: 180 }}
              onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} />
            <TextInput aria-label="Email" type="email" value={draft.email} style={{ width: 200 }}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            <TextInput aria-label="Organisation" value={draft.organisation ?? ''} style={{ width: 150 }}
              onChange={(e) => setDraft({ ...draft, organisation: e.target.value })} />
            <TextInput aria-label="Phone" value={draft.phone ?? ''} style={{ width: 120 }}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            <TextInput aria-label="Discord username" placeholder="Discord" value={draft.discordUsername ?? ''}
              style={{ width: 140 }}
              onChange={(e) => setDraft({ ...draft, discordUsername: e.target.value })} />
            <button type="submit" disabled={busy}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td style={CELL}>{person.fullName}</td>
      <td style={CELL}>{person.email}</td>
      {/* An em dash, not an empty cell: "we do not have this" is a fact worth showing (P5.1). */}
      <td style={CELL}>{person.organisation ?? '—'}</td>
      <td style={CELL}>{person.phone ?? '—'}</td>
      {/* Named AND resolved are different facts: a username the bot could not find is one the
          team cannot be DMed at, and the organiser should see that before the night. */}
      <td style={CELL}>
        {person.discordUsername === null ? '—' : (
          <>
            {person.discordUsername}
            {person.discordUserId === null && (
              <span style={{ color: 'var(--warn)' }}> (not found in server)</span>
            )}
          </>
        )}
      </td>
      <td style={{ ...CELL, textAlign: 'right' }}>
        {removing ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <select
              aria-label={`Why ${person.fullName} is being removed`} disabled={busy}
              defaultValue=""
              onChange={(e) => { if (e.target.value !== '') onRemove(e.target.value) }}
              style={{ font: 'inherit', padding: '3px 6px' }}
            >
              <option value="" disabled>Reason…</option>
              {REMOVAL_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <button type="button" onClick={() => setRemoving(false)}>Keep</button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button type="button" disabled={busy} onClick={begin}>Edit</button>
            <button type="button" disabled={busy} onClick={() => setRemoving(true)}>Remove</button>
          </span>
        )}
      </td>
    </tr>
  )
}

const CELL: React.CSSProperties = {
  padding: '4px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle',
}
