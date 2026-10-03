import { useRef, useState } from 'react'
import { FormField, TextInput } from './FormField.js'
import type { LookupOutcome } from '../lib/registerApi.js'

/**
 * The people on the team, and how to reach each of them (migration 100).
 *
 * Split out of `TeamBuilder` when every member gained a Discord box: a list of rows with an
 * input in each is its own thing, and the builder's job is the team name, the count and the
 * confirm.
 *
 * A teammate's Discord username is optional and unchecked here, deliberately. The registrant's
 * own is checked live because it is one name and they can fix it; checking six more on a phone
 * over venue WiFi is six round trips to Discord before anyone can press the button. The server
 * resolves all of them on confirm and the screen then says which ones it could not match, which
 * is the same information one step later and costs nothing while the form is being filled in.
 */
export interface Teammate {
  participantId: number
  fullName: string
  email: string
  /** As typed. Empty means "email only for this person", which is always allowed. */
  discordUsername: string
}

export function TeammateRoster({
  registrantName, teammates, busy, discordEnabled, onRemove, onDiscordChange,
}: {
  registrantName: string
  teammates: readonly Teammate[]
  busy: boolean
  /** False when no bot is configured: the column is then not shown rather than shown as dead. */
  discordEnabled: boolean
  onRemove: (participantId: number) => void
  onDiscordChange: (participantId: number, username: string) => void
}) {
  return (
    <ul aria-label="Team members" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
      <li style={ROW}>
        <span style={{ fontWeight: 600 }}>
          {registrantName} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(you)</span>
        </span>
      </li>
      {teammates.map((t) => (
        <li key={t.participantId} style={ROW} className="stack-narrow">
          <span style={{ flex: '1 1 160px', minWidth: 0 }}>
            {t.fullName}
            <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>{t.email}</span>
          </span>
          {discordEnabled && (
            <span style={{ flex: '1 1 180px', minWidth: 0 }}>
              <label htmlFor={`mate-discord-${t.participantId}`} className="sr-only">
                Discord username for {t.fullName}
              </label>
              <TextInput id={`mate-discord-${t.participantId}`} value={t.discordUsername}
                autoComplete="off" disabled={busy} placeholder="Discord username (optional)"
                onChange={(e) => onDiscordChange(t.participantId, e.target.value)} />
            </span>
          )}
          <button type="button" aria-label={`Remove ${t.fullName}`} disabled={busy}
            onClick={() => onRemove(t.participantId)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  )
}

/** One address at a time, confirmed by the server. Focus returns to the box after each add. */
export function TeammateAdder({
  busy, full, onLookup, onFound,
}: {
  busy: boolean
  full: boolean
  onLookup: (email: string) => Promise<LookupOutcome>
  onFound: (teammate: Teammate) => void
}) {
  const [email, setEmail] = useState('')
  const [lookup, setLookup] = useState<LookupOutcome | null>(null)
  const [checking, setChecking] = useState(false)
  const box = useRef<HTMLInputElement>(null)

  async function add() {
    const address = email.trim()
    if (address === '' || checking) return
    setChecking(true)
    try {
      const result = await onLookup(address)
      setLookup(result)
      if (result.found && result.participantId !== undefined && result.fullName !== undefined) {
        onFound({
          participantId: result.participantId, fullName: result.fullName, email: address,
          discordUsername: '',
        })
        setEmail('')
      }
    } finally {
      setChecking(false)
      box.current?.focus()
    }
  }

  return (
    <FormField id="reg-teammate" label="Add a teammate by email"
      hint="Their exact address as it is on the participant list. One at a time — press Enter."
      error={lookup && !lookup.found ? lookup.message : null}>
      <div style={{ display: 'flex', gap: 6 }}>
        <TextInput id="reg-teammate" ref={box} type="email" value={email} autoComplete="off"
          disabled={busy || full}
          onChange={(e) => { setEmail(e.target.value); setLookup(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add() } }} />
        <button type="button" disabled={busy || checking || email.trim() === '' || full}
          onClick={() => void add()}>
          Add
        </button>
      </div>
      {lookup?.found && (
        <p role="status" style={{ fontSize: 12, color: 'var(--ok)', margin: '4px 0 0' }}>{lookup.message}</p>
      )}
    </FormField>
  )
}

const ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
  borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
}
