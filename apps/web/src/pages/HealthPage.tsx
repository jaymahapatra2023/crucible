import { get } from '../lib/apiClient.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'

interface Health {
  status: string
  database: { reachable: boolean; migrations: number }
  providers: Array<{ name: string; available: boolean }>
  /** Safety ceilings that refused a request (E41-S01 acceptance 7). A trip means a loop. */
  ceilings?: { enabled: boolean; trips: Array<{ route: string; count: number; lastAt: string }> }
  /** How teams are reached (E49): the mail adapter, and whether Discord sits in front of it. */
  delivery?: { mail: string; discord: 'live' | 'off' | 'unconfigured'; guildId: string | null }
}

/** Operational health (P9.4). Shows what is degraded, not just a green tick. */
export function HealthPage() {
  const { state, reload } = useAsyncData<Health>(() => get<Health>('/platform/health'), [])

  if (state.status === 'loading') return <LoadingState label="Checking health" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Health could not be read"
        message={state.error.message}
        onRetry={reload}
      />
    )
  }

  const h = state.data
  return (
    <section>
      <h1 style={{ fontSize: 18 }}>Health</h1>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 20px' }}>
        <dt>Status</dt>
        <dd style={{ margin: 0 }}>{h.status}</dd>
        <dt>Database</dt>
        <dd style={{ margin: 0 }}>
          {h.database.reachable ? `reachable, ${h.database.migrations} migration(s) applied` : 'unreachable'}
        </dd>
        <dt>Team delivery</dt>
        <dd style={{ margin: 0 }}>
          {h.delivery
            ? `mail: ${h.delivery.mail}; Discord DM: ${h.delivery.discord}`
              + (h.delivery.guildId ? ` (server ${h.delivery.guildId})` : '')
            : 'unknown'}
        </dd>
        <dt>Model providers</dt>
        <dd style={{ margin: 0 }}>
          {h.providers.length === 0
            ? 'none registered'
            : h.providers.map((p) => `${p.name} (${p.available ? 'available' : 'unavailable'})`).join(', ')}
        </dd>
      </dl>
      <Ceilings ceilings={h.ceilings} />
    </section>
  )
}

/**
 * Whether a safety ceiling has refused anybody (E41).
 *
 * A ceiling sits an order of magnitude above legitimate use, so a trip is never "a busy team" —
 * it is a client looping, and somebody should find out which. Said here, because the log line
 * it also writes is not read at 23:00 on the night.
 */
function Ceilings({ ceilings }: { ceilings: Health['ceilings'] }) {
  if (!ceilings) return null
  return (
    <section style={{ marginTop: 20 }} aria-labelledby="ceilings-heading">
      <h2 id="ceilings-heading" style={{ fontSize: 15 }}>Safety ceilings</h2>
      {!ceilings.enabled && (
        <p style={{ color: 'var(--warn)' }}>Switched off (feature.http.rate_limit). Nothing is being counted.</p>
      )}
      {ceilings.trips.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No ceiling has refused a request since the API started.</p>
      ) : (
        <ul aria-label="Tripped ceilings">
          {ceilings.trips.map((t) => (
            <li key={t.route}>
              <code>{t.route}</code> refused <strong>{t.count}</strong> request{t.count === 1 ? '' : 's'},
              last at {new Date(t.lastAt).toLocaleString()} — something is retrying in a loop;
              find out what before it reaches a team.
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
