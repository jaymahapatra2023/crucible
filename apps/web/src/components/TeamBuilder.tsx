import { useEffect, useState } from 'react'
import { FormField, TextInput } from './FormField.js'
import { DiscordField } from './DiscordField.js'
import { TeammateAdder, TeammateRoster, type Teammate } from './TeammateRoster.js'
import type { DiscordCheck, LinkScope, LookupOutcome, NameCheck } from '../lib/registerApi.js'

/**
 * Building a team inside a registration link (E44-S02, E44-S04).
 *
 * It looks like selection and never is one. Teammates arrive by EXACT address, confirmed one at
 * a time by the server — because a `<select>` of participants on a public page is a directory of
 * two hundred people's names and addresses (II.1). There is no dropdown at all: the challenge is
 * chosen at submission, when the team knows which path it took and can see the rubric.
 *
 * Each member may also give a Discord username (migration 100), because the code goes out on
 * both channels and a code that reached only the person who has gone to sleep is a code the team
 * lacks. Optional for everybody: nobody is blocked from registering for want of Discord.
 *
 * Nothing here writes. The plan is assembled on screen and sent whole on confirm, the way every
 * import in this system checks a file before loading it.
 */
export type { Teammate } from './TeammateRoster.js'

export function TeamBuilder({
  scope, busy, failure, onCheckName, onLookup, onCheckDiscord, onConfirm,
}: {
  scope: LinkScope
  busy: boolean
  failure: string | null
  onCheckName: (name: string) => Promise<NameCheck>
  onLookup: (email: string) => Promise<LookupOutcome>
  /** Checks a Discord username against the event server (E49). Absent when Discord is off. */
  onCheckDiscord?: (username: string) => Promise<DiscordCheck>
  onConfirm: (plan: {
    displayName: string
    teammateIds: number[]
    discordUsername: string | null
    teammateDiscord: { participantId: number; username: string }[]
  }) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [teammates, setTeammates] = useState<Teammate[]>([])
  const [discordUsername, setDiscordUsername] = useState('')
  const nameCheck = useNameCheck(displayName, onCheckName)

  // The registrant is always a member. The count includes them.
  const count = teammates.length + 1
  const reasons = reasonsToWait({ displayName, nameCheck, count, bounds: scope.bounds })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (reasons.length > 0) return
        onConfirm({
          displayName: displayName.trim(),
          teammateIds: teammates.map((t) => t.participantId),
          discordUsername: discordUsername.trim() === '' ? null : discordUsername.trim(),
          teammateDiscord: teammates
            .filter((t) => t.discordUsername.trim() !== '')
            .map((t) => ({ participantId: t.participantId, username: t.discordUsername.trim() })),
        })
      }}
      style={{ maxWidth: 640 }}
    >
      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        Registering as <strong>{scope.registrantName}</strong>. You are on the team automatically.
      </p>

      <FormField id="reg-name" label="Team name" required
        hint="Compared ignoring case, punctuation and a leading “the” — pick something that differs by more than that."
        error={nameCheck && !nameCheck.ok ? nameCheck.message : null}>
        <TextInput id="reg-name" value={displayName} autoComplete="off"
          onChange={(e) => setDisplayName(e.target.value)} />
        {nameCheck?.ok && (
          <p role="status" style={{ fontSize: 12, color: 'var(--ok)', margin: '4px 0 0' }}>Available.</p>
        )}
      </FormField>

      {/* The member count is the primary signal, against the bound (E44-S04 acceptance 4). */}
      <p style={{ margin: '12px 0 4px' }}>
        <span data-testid="member-count" style={{ fontSize: 24, fontWeight: 700 }}>{count}</span>
        <span style={{ color: 'var(--text-muted)' }}> of {scope.bounds.min}–{scope.bounds.max} members</span>
      </p>

      <TeammateRoster registrantName={scope.registrantName} teammates={teammates} busy={busy}
        discordEnabled={scope.discord.enabled}
        onRemove={(id) => setTeammates((prev) => prev.filter((m) => m.participantId !== id))}
        onDiscordChange={(id, username) => setTeammates((prev) => prev.map((m) =>
          m.participantId === id ? { ...m, discordUsername: username } : m))} />

      <TeammateAdder busy={busy} full={count >= scope.bounds.max} onLookup={onLookup}
        onFound={(t) => setTeammates((prev) =>
          prev.some((m) => m.participantId === t.participantId) ? prev : [...prev, t])} />

      {onCheckDiscord && (
        <DiscordField enabled={scope.discord.enabled} inviteUrl={scope.discord.inviteUrl}
          value={discordUsername} busy={busy} onChange={setDiscordUsername} onCheck={onCheckDiscord} />
      )}

      {failure !== null && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {/* Disabled WITH the reason stated (acceptance 5) — never enabled into a refusal. */}
      <button type="submit" disabled={busy || reasons.length > 0}>Register the team</button>
      {reasons.length > 0 ? (
        <p role="status" style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0' }}>
          To register: {reasons.join(', ')}.
        </p>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0' }}>
          {whereItGoes({
            discordEnabled: scope.discord.enabled,
            mine: discordUsername.trim(),
            email: scope.registrantEmail,
            teammatesWithDiscord: teammates.filter((t) => t.discordUsername.trim() !== '').length,
          })}
        </p>
      )}
    </form>
  )
}

/**
 * What the form promises before the button is pressed. Written out, never implied (P5.4), and
 * pure so the promise can be tested against what actually happens.
 */
export function whereItGoes(input: {
  discordEnabled: boolean
  mine: string
  email: string
  teammatesWithDiscord: number
}): string {
  const mine = input.discordEnabled && input.mine !== ''
    ? `Your submission code will be emailed to ${input.email} and sent to ${input.mine} on Discord.`
    : `Your submission code will be emailed to ${input.email}.`
  if (input.teammatesWithDiscord === 0) {
    return `${mine} Every teammate gets it by email too.`
  }
  const n = input.teammatesWithDiscord
  return `${mine} Every teammate gets it by email, and ${n} of them on Discord as well.`
}

/**
 * Why the button is disabled, in the operator's order of work. Pure, so it is testable without
 * rendering and cannot disagree with what the button does.
 */
export function reasonsToWait(input: {
  displayName: string
  nameCheck: NameCheck | null
  count: number
  bounds: { min: number; max: number }
}): string[] {
  const reasons: string[] = []
  if (input.displayName.trim().length < 2) reasons.push('name the team')
  else if (input.nameCheck && !input.nameCheck.ok) reasons.push('choose a name that is not taken')
  const short = input.bounds.min - input.count
  if (short > 0) reasons.push(`add ${short} more ${short === 1 ? 'teammate' : 'teammates'}`)
  if (input.count > input.bounds.max) reasons.push(`remove ${input.count - input.bounds.max}`)
  return reasons
}

/**
 * Checked live, debounced. The collision rule is the server's (`team_normalise`), and asking on
 * every keystroke would be forty requests for one name.
 *
 * The result is DERIVED from what was checked: a result for an older name is not shown for the
 * current one, without an effect having to clear it — a synchronous setState inside an effect
 * is a render cascade waiting to happen.
 */
function useNameCheck(displayName: string, check: (name: string) => Promise<NameCheck>): NameCheck | null {
  const [checked, setChecked] = useState<{ name: string; result: NameCheck } | null>(null)
  const trimmed = displayName.trim()

  useEffect(() => {
    if (trimmed.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      void check(trimmed).then((result) => { if (!cancelled) setChecked({ name: trimmed, result }) })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [trimmed, check])

  return checked !== null && checked.name === trimmed ? checked.result : null
}
