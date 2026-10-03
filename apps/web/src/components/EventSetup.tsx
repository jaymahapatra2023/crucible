import { useState } from 'react'
import { FormField, TextInput } from './FormField.js'
import type { EventSettings } from '../lib/eventApi.js'

/**
 * The facts about this event (E19-S01).
 *
 * Two settings ship unset and silently disable what depends on them, which is the reason this
 * surface exists: without an evaluation date, the dry run cannot be shown to have happened
 * early enough; without an event window, provenance cannot flag work committed outside it, and
 * the threshold beside it has nothing to apply to.
 *
 * So each field states its consequence, not just its name. A setting whose effect is invisible
 * is a setting nobody sets.
 */
export function EventSetup({
  settings, busy, onSaveDate, onSaveWindow,
}: {
  settings: EventSettings
  busy: boolean
  onSaveDate: (date: string) => void
  onSaveWindow: (startsAt: string, endsAt: string) => void
}) {
  const [date, setDate] = useState(settings.evaluationDate ?? '')
  const [startsAt, setStartsAt] = useState(toLocal(settings.window?.startsAt))
  const [endsAt, setEndsAt] = useState(toLocal(settings.window?.endsAt))

  const ordered = startsAt !== '' && endsAt !== '' && endsAt > startsAt

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 20,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>This event</h2>

      <form onSubmit={(e) => { e.preventDefault(); if (date !== '') onSaveDate(date) }}>
        <FormField
          id="ev-date" label="Evaluation date" required
          hint={`The night this runs. The dry run has to happen at least `
            + `${settings.dryRunLeadDays} days before it, and until this is set that cannot be `
            + `checked either way.`}
        >
          <TextInput id="ev-date" type="date" value={date}
            onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <button type="submit" disabled={busy || date === ''}>Save the date</button>
      </form>

      <form
        style={{ marginTop: 22, borderTop: '1px solid var(--border)', paddingTop: 16 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (ordered) {
            onSaveWindow(new Date(startsAt).toISOString(), new Date(endsAt).toISOString())
          }
        }}
      >
        <h3 style={{ fontSize: 14, marginTop: 0 }}>Event window</h3>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          When the hackathon itself ran. Commits outside this window are <strong>flagged for a
          person to look at</strong> — never excluded, and never acted on automatically. Until it
          is set, that check cannot run at all.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField id="ev-start" label="Work could start" required>
            <TextInput id="ev-start" type="datetime-local" value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)} />
          </FormField>
          <FormField
            id="ev-end" label="Work had to stop" required
            error={startsAt !== '' && endsAt !== '' && !ordered
              ? 'The window must end after it starts.' : null}
          >
            <TextInput id="ev-end" type="datetime-local" value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)} />
          </FormField>
        </div>
        <button type="submit" disabled={busy || !ordered}>Save the window</button>
      </form>
    </section>
  )
}

/** An ISO instant as a `datetime-local` value, in the organiser's own timezone. */
function toLocal(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
