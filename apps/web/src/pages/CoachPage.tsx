import { useState } from 'react'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { confirmArrival, getCoachNames } from '../lib/arrivalApi.js'

/**
 * "I'm here" for coaches (migration 105).
 *
 * One tap. A coach walking into the building on a phone finds their name and presses it; asking
 * them to type an address first is the step that stops people bothering, and the organisers then
 * have no idea who is on site.
 *
 * The list is names only. A coach's name is already printed on the door of the room they are
 * coaching in, so showing it costs nothing, and nothing else about them appears here.
 *
 * Filtering is local to the browser: the whole list arrives in one request, so typing narrows it
 * without a round trip and without telling the server what anybody searched for.
 */
export function CoachPage() {
  const [filter, setFilter] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { state } = useAsyncData(() => getCoachNames(), [])

  if (done !== null) {
    return (
      <section style={{ maxWidth: 560 }}>
        <h1 style={{ fontSize: 19 }}>You are marked as here</h1>
        <p role="status" data-testid="coach-confirmed" style={{
          border: '1px solid var(--border)', borderRadius: 8, padding: 12,
        }}>
          {done}
        </p>
      </section>
    )
  }

  if (state.status === 'loading') return <LoadingState label="Loading the coach list" />
  if (state.status === 'error') {
    return <ErrorState title="The coach list could not be loaded" message={state.error.message}
      detail="Find an organiser and they will mark you as here." />
  }

  const needle = filter.trim().toLowerCase()
  const shown = needle === ''
    ? state.data
    : state.data.filter((n) => n.toLowerCase().includes(needle))

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={{ fontSize: 19 }}>Coaches: let us know you are here</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        Find your name and press it. That is all — we use this to make sure no team is left
        without a coach.
      </p>

      <label htmlFor="coach-filter" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        Find your name
      </label>
      <input id="coach-filter" value={filter} autoComplete="off" placeholder="Start typing"
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)' }} />

      {failure !== null && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {shown.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          No coach matches that. Check the spelling, or find an organiser.
        </p>
      ) : (
        <ul aria-label="Coaches" style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {shown.map((name) => (
            <li key={name} style={{ borderBottom: '1px solid var(--border)' }}>
              <button type="button" disabled={busy} style={{
                width: '100%', textAlign: 'left', padding: '10px 8px', background: 'none',
                border: 'none', font: 'inherit', cursor: 'pointer',
              }} onClick={async () => {
                setBusy(true); setFailure(null)
                try {
                  setDone((await confirmArrival(name)).message)
                } catch (err) {
                  setFailure(err instanceof Error ? err.message : 'That could not be sent.')
                } finally {
                  setBusy(false)
                }
              }}>
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
