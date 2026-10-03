/**
 * Watching a cohort run (E10-S05).
 *
 * Polls rather than holding a websocket. The story's requirement is that progress survives a
 * page reload, and a poll of stored state satisfies that by construction: what this page shows
 * an hour in is exactly what it would show to somebody opening it for the first time.
 *
 * Polling stops once the run reaches a terminal state, so a finished run left open overnight
 * does not keep asking.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getBatchProgress, type BatchProgress } from '../lib/batchApi.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { BatchProgressView } from '../components/BatchProgressView.js'

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'])
const POLL_MS = 3000

export function BatchRunPage() {
  const { runId } = useParams()
  const run = Number(runId)
  const [tick, setTick] = useState(0)

  const { state } = useAsyncData<BatchProgress>(() => getBatchProgress(run), [run, tick])

  const status = state.status === 'ready' ? state.data.status : null

  useEffect(() => {
    // A finished run has nothing further to say; a failed fetch stops too, because polling an
    // endpoint that is erroring turns one visible problem into a silent loop.
    if (status === null || TERMINAL.has(status)) return undefined
    const timer = setTimeout(() => setTick((n) => n + 1), POLL_MS)
    return () => clearTimeout(timer)
  }, [status, tick])

  if (state.status === 'loading') return <LoadingState label="Loading run progress" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Run progress could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={() => setTick((n) => n + 1)}
      />
    )
  }

  return (
    <section>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Cohort run</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0' }}>
          Scan, then build, then score. A submission that fails a stage is recorded and the run
          carries on.
        </p>
      </header>

      <BatchProgressView progress={state.data} />
    </section>
  )
}
