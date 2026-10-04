import { useState } from 'react'
import { FormField, TextInput } from '../components/FormField.js'
import { submitConfirmation } from '../lib/confirmApi.js'

/**
 * "Check my details" — the third public screen, alongside register and submit (migration 104).
 *
 * For the people who signed up on paper. They are on the roster under a placeholder address and
 * sometimes a misread name, and this is how they say "that is me, here is my real email" without
 * queueing at a desk.
 *
 * It shows NOTHING back. No record, no confirmation that the name was found, no hint that it was
 * not. The reply is one fixed sentence, because a public page that answered differently would be
 * a way to discover who is at the event one name at a time — and because a page that let you
 * rewrite somebody's address would put you on their team's emails, including the one carrying
 * their submission code. An organiser confirms each claim instead, which takes seconds.
 */
export function ConfirmPage() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const ready = fullName.trim().length >= 2 && /.+@.+\..+/.test(email.trim())

  if (done !== null) {
    return (
      <section style={{ maxWidth: 560 }}>
        <h1 style={{ fontSize: 19 }}>Thank you</h1>
        <p role="status" data-testid="confirm-sent" style={{
          border: '1px solid var(--border)', borderRadius: 8, padding: 12,
        }}>
          {done}
        </p>
      </section>
    )
  }

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: 19 }}>Check your details</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        If you signed up on paper, or your name or email is wrong on our list, tell us here. An
        organiser will put it right. You do not need to wait for a reply.
      </p>

      <form onSubmit={async (e) => {
        e.preventDefault()
        if (!ready || busy) return
        setBusy(true); setFailure(null)
        try {
          setDone((await submitConfirmation({
            fullName: fullName.trim(), email: email.trim(),
          })).message)
        } catch (err) {
          setFailure(err instanceof Error ? err.message : 'That could not be sent.')
        } finally {
          setBusy(false)
        }
      }}>
        <FormField id="confirm-name" label="Your full name" required
          hint="As you wrote it, or as you would like it to appear.">
          <TextInput id="confirm-name" value={fullName} autoComplete="name"
            onChange={(e) => setFullName(e.target.value)} />
        </FormField>

        <FormField id="confirm-email" label="Your email" required
          hint="The address you actually read. Your team's details will be sent to it."
          error={failure}>
          <TextInput id="confirm-email" type="email" value={email} autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} />
        </FormField>

        <button type="submit" disabled={busy || !ready}>Send this to an organiser</button>
      </form>
    </section>
  )
}
