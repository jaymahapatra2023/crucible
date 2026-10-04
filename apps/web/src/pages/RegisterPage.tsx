/**
 * Participants register their own teams (E44-S04).
 *
 * The second public screen, in the same shape as `/submit`: no account, no navigation that
 * implies one. Three states. Before a link: one email box. With a link (`?link=` from the
 * email): the team builder. After confirming: the code has been emailed — to which address, and
 * what to do if it does not arrive. The token is never on this screen (E44-S03 acceptance 4).
 */
import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FormField, TextInput } from '../components/FormField.js'
import { TeamBuilder } from '../components/TeamBuilder.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import {
  checkDiscord, checkName, confirmRegistration, getLinkScope, lookupTeammate, startRegistration,
  type ConfirmOutcome, type StartOutcome,
} from '../lib/registerApi.js'

export function RegisterPage() {
  const [params] = useSearchParams()
  const link = params.get('link')
  return link ? <WithLink link={link} /> : <Start />
}

function Start() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<StartOutcome | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: 19 }}>Register your team</h1>

      {/* The single most expensive misunderstanding on the day: four people registering the
          same team four times, taking four slots, four rooms and four coaches between them.
          Said first, said twice, and said in the strongest place on the page (P5.4). */}
      <div role="note" style={{
        border: '2px solid var(--accent)', borderRadius: 8, padding: 12, margin: '12px 0',
      }}>
        <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>
          One registration per team. Not one per person.
        </p>
        <p style={{ margin: '6px 0 0', fontSize: 13 }}>
          <strong>Any one member registers on behalf of everybody.</strong> They add the rest of
          the team by email address, and everyone then gets the team’s details. If two of you do
          this, your team is registered twice and ends up split across two rooms with two
          different coaches.
        </p>
        <p style={{ margin: '6px 0 0', fontSize: 13 }}>
          Decide between you who is doing it, and let them finish before anybody else tries.
        </p>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        If that is you, enter the email address you registered with. A link will be sent to it;
        from there you name the team and add your teammates.
      </p>

      {outcome?.status === 'SENT' ? (
        <p role="status" data-testid="link-sent" style={{
          border: '1px solid var(--border)', borderRadius: 8, padding: 12,
        }}>
          {outcome.message}
        </p>
      ) : (
        <form onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true); setFailure(null)
          try { setOutcome(await startRegistration(email.trim())) }
          catch (err) { setFailure(err instanceof Error ? err.message : 'That could not be sent.') }
          finally { setBusy(false) }
        }}>
          <FormField id="reg-email" label="Your email" required
            error={outcome ? outcome.message : failure}>
            <TextInput id="reg-email" type="email" value={email} autoComplete="email"
              onChange={(e) => { setEmail(e.target.value); setOutcome(null) }} />
          </FormField>
          <button type="submit" disabled={busy || email.trim() === ''}>Send me the link</button>
        </form>
      )}
    </section>
  )
}

function WithLink({ link }: { link: string }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<ConfirmOutcome | null>(null)
  const { state } = useAsyncData(() => getLinkScope(link), [link])

  const onCheckName = useCallback((name: string) => checkName(link, name), [link])
  const onLookup = useCallback((email: string) => lookupTeammate(link, email), [link])
  const onCheckDiscord = useCallback((username: string) => checkDiscord(link, username), [link])

  if (state.status === 'loading') return <LoadingState label="Checking your link" />
  if (state.status === 'error') {
    return (
      <ErrorState title="This link cannot be used" message={state.error.message}
        detail="Start again from the registration page and a new link will be sent." />
    )
  }
  if (done) return <Done outcome={done} />

  return (
    <section>
      <h1 style={{ fontSize: 19 }}>Register your team</h1>
      <TeamBuilder
        scope={state.data} busy={busy} failure={failure}
        onCheckName={onCheckName} onLookup={onLookup} onCheckDiscord={onCheckDiscord}
        onConfirm={(plan) => {
          setBusy(true); setFailure(null)
          confirmRegistration(link, plan)
            .then(setDone)
            .catch((err: unknown) => setFailure(err instanceof Error ? err.message : 'Registration failed.'))
            .finally(() => setBusy(false))
        }}
      />
    </section>
  )
}

function Done({ outcome }: { outcome: ConfirmOutcome }) {
  return (
    <section style={{ maxWidth: 560 }} data-testid="registered">
      <h1 style={{ fontSize: 19 }}>{outcome.displayName} is registered</h1>
      <p>{outcome.memberCount} members.</p>
      <p>{outcome.message}</p>
      {(outcome.tokenSentVia === 'discord' || outcome.tokenSentVia === 'both') && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Check your Discord DMs from the event server's bot. If nothing arrives within a few
          minutes, ask an organiser — they can see whether it was delivered.
        </p>
      )}
      {outcome.discordNote !== null && (
        <p role="status" style={{ color: 'var(--warn)', fontSize: 13 }}>
          Discord: {outcome.discordNote}
        </p>
      )}
      {/* Said per teammate, naming them: an unmatched username is fixable only by whoever
          knows whose it is, and they are reading this screen (migration 100). */}
      {outcome.memberDiscordNotes.length > 0 && (
        <div role="status" style={{ color: 'var(--warn)', fontSize: 13 }} data-testid="member-discord-notes">
          <p style={{ marginBottom: 4 }}>
            Some teammates' Discord usernames could not be used. They will get the code by email.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {outcome.memberDiscordNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      )}
      {outcome.tokenSentVia === 'discord' ? null : outcome.tokenEmailed ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Check <strong>{outcome.emailedTo}</strong>, including the junk folder. If nothing arrives
          within a few minutes, ask an organiser — they can see it was not delivered and send it
          another way.
        </p>
      ) : (
        <p role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>
          The failed delivery is recorded where organisers look, and they will send your code
          another way. Nothing more is needed from you.
        </p>
      )}
    </section>
  )
}
