import { useState } from 'react'
import { FormField, TextInput } from './FormField.js'
import type { DiscordCheck } from '../lib/registerApi.js'

/**
 * Where the code will be sent (E49-S02).
 *
 * A Discord username, checked against the event server on request rather than on every
 * keystroke: the check is a call to Discord, and a username is short. Found, the display name
 * is confirmed and the code goes by DM. Not found, the form says to join the server first —
 * with the invite when the organiser set one — and registration carries on by email. Optional
 * throughout: nobody is blocked from registering for lack of Discord.
 */
export function DiscordField({
  enabled, inviteUrl, value, busy, onChange, onCheck,
}: {
  enabled: boolean
  inviteUrl: string
  value: string
  busy: boolean
  onChange: (next: string) => void
  onCheck: (username: string) => Promise<DiscordCheck>
}) {
  const [checked, setChecked] = useState<{ username: string; result: DiscordCheck } | null>(null)
  const [checking, setChecking] = useState(false)
  if (!enabled) return null

  const current = checked !== null && checked.username === value.trim() ? checked.result : null

  async function check() {
    const username = value.trim()
    if (username === '' || checking) return
    setChecking(true)
    try {
      setChecked({ username, result: await onCheck(username) })
    } catch {
      setChecked({ username, result: { found: false, displayName: null, message: 'Discord could not be checked just now.' } })
    } finally {
      setChecking(false)
    }
  }

  return (
    <FormField id="reg-discord" label="Your Discord username (optional)"
      hint={'Your submission code is sent to you by Discord DM when you give this; by email otherwise. '
        + 'You must be in the event server' + (inviteUrl ? ` — ${inviteUrl}` : '') + '.'}
      error={current && !current.found ? current.message : null}>
      <div style={{ display: 'flex', gap: 6 }}>
        <TextInput id="reg-discord" value={value} autoComplete="off" placeholder="username"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void check() } }} />
        <button type="button" disabled={busy || checking || value.trim() === ''} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check'}
        </button>
      </div>
      {current?.found && (
        <p role="status" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ok)' }}>
          Found: <strong>{current.displayName}</strong>. Your code will be sent there.
        </p>
      )}
    </FormField>
  )
}
