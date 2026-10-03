import { useState } from 'react'
import { TextInput } from './FormField.js'

/**
 * Correct a team's name or contact where the team is listed (E48-S01 acceptance 2).
 *
 * An organiser's act, never a side effect of anything else (E45 removed the last of those).
 * Sends only what changed, so a contact correction is not also a no-op rename in the audit
 * trail; the server refuses a name that collides with another team and names the clash.
 */
export function TeamEditControl({
  teamId, displayName, contactEmail, busy, onSave,
}: {
  teamId: number
  displayName: string
  contactEmail: string
  busy: boolean
  onSave: (teamId: number, patch: { displayName?: string; contactEmail?: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(displayName)
  const [contact, setContact] = useState(contactEmail)

  const patch = {
    ...(name.trim() !== displayName && { displayName: name.trim() }),
    ...(contact.trim() !== contactEmail && { contactEmail: contact.trim() }),
  }
  const changed = Object.keys(patch).length > 0
  const valid = name.trim().length >= 2 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.trim())

  if (!open) {
    return (
      // Named by id, not by display name: every other control naming this team is matched by
      // that name, and an edit button that also matched would make each of them ambiguous.
      <button type="button" disabled={busy} aria-label={`Edit team #${teamId}`}
        onClick={() => { setName(displayName); setContact(contactEmail); setOpen(true) }}
        style={{ fontSize: 12, padding: '1px 6px', marginLeft: 6 }}>
        Edit
      </button>
    )
  }

  return (
    <form aria-label={`Edit team #${teamId}`} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}
      onSubmit={(e) => { e.preventDefault(); if (changed && valid) { onSave(teamId, patch); setOpen(false) } }}>
      <TextInput aria-label="Team name" value={name} onChange={(e) => setName(e.target.value)}
        style={{ width: 160 }} />
      <TextInput aria-label="Contact email" type="email" value={contact}
        onChange={(e) => setContact(e.target.value)} style={{ width: 200 }} />
      <button type="submit" disabled={busy || !changed || !valid} style={{ fontSize: 12 }}>Save</button>
      <button type="button" onClick={() => setOpen(false)} style={{ fontSize: 12 }}>Cancel</button>
    </form>
  )
}
