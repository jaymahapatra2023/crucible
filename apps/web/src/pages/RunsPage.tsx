import { getPage, type Page } from '../lib/apiClient.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'

interface RunSummary {
  runId: number
  kind: string
  status: string
  startedAt: string
  finishedAt: string | null
  costUsd: number
}

/**
 * Run ledger view (E01-S05).
 *
 * The count in the heading is the backend total, and a bounded page says "showing X of Y"
 * (P5.7) — never the length of what happened to be fetched.
 */
export function RunsPage() {
  const { state, reload } = useAsyncData<Page<RunSummary>>(
    () => getPage<RunSummary>('/platform/runs?page=1&pageSize=20'),
    [],
  )

  if (state.status === 'loading') return <LoadingState label="Loading runs" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Runs could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={reload}
      />
    )
  }

  const { items, total, pageSize } = state.data
  if (total === 0) {
    return (
      <EmptyState
        title="No runs yet"
        explanation="A run is created when you evaluate a cohort. Start one from the batch console."
      />
    )
  }

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Runs</h1>
        <span style={{ color: 'var(--text-muted)' }}>
          {items.length < total ? `showing ${items.length} of ${total}` : `${total} total`}
        </span>
      </header>
      <table>
        <caption className="sr-only" style={{ position: 'absolute', left: -9999 }}>
          Evaluation runs, most recent first
        </caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            <th scope="col">Cost (USD)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.runId}>
              <td>#{r.runId}</td>
              <td>{r.kind}</td>
              <td>{r.status}</td>
              <td>{new Date(r.startedAt).toLocaleString()}</td>
              <td>{r.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length < total && (
        <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>
          Showing the most recent {pageSize}. {total - items.length} older run(s) not shown.
        </p>
      )}
    </section>
  )
}
