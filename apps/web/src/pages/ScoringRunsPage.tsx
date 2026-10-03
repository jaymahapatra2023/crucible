/**
 * The scoring runs, and the way into review (E08).
 *
 * Added during E08's review pass for a plain reason: every review screen needed a run id, and
 * nothing in the application told anyone what the run ids were. A committee that has to be
 * handed a URL cannot "confirm a shortlist quickly", which is the epic's stated goal.
 *
 * Each row says what state the run is in, because the three states lead to different places: a
 * run that has not been ranked has nothing to review, and a finalised shortlist is a record
 * rather than a workspace.
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getScoringRuns, type ScoringRun } from '../lib/reviewApi.js'
import { startBatch } from '../lib/batchApi.js'
import { listChallenges, type Challenge } from '../lib/challengeApi.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { StartRunPanel } from '../components/StartRunPanel.js'

interface PageData {
  runs: ScoringRun[]
  challenges: Challenge[]
}

export function ScoringRunsPage() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const { state, reload } = useAsyncData<PageData>(async () => ({
    runs: await getScoringRuns(),
    // Empty rather than fatal: the run list is still worth showing to somebody who cannot
    // start one.
    challenges: await listChallenges().catch(() => [] as Challenge[]),
  }), [])

  if (state.status === 'loading') return <LoadingState label="Loading scoring runs" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Scoring runs could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={reload}
      />
    )
  }

  const { runs, challenges } = state.data

  /**
   * Start a run and go straight to its progress.
   *
   * The request returns as soon as the run is opened, not when it finishes — so navigating
   * immediately is correct, and waiting would leave the operator looking at a spinner for hours.
   */
  async function start(input: { cohortKey: string; challengeIds: number[]; runIndex: 1 | 2 }) {
    setBusy(true)
    setFailure(null)
    try {
      const started = await startBatch(input)
      navigate(`/batch/runs/${started.runId}`)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The run could not be started.')
      setBusy(false)
    }
  }

  return (
    <section>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Scoring runs</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0' }}>
          Each cohort is scored twice. A run has to be ranked before it can be reviewed.
        </p>
      </header>

      <StartRunPanel
        challenges={challenges} busy={busy} failure={failure}
        existing={runs.map((r) => ({ cohortKey: r.cohort_key, runIndex: r.run_index }))}
        onStart={(i) => void start(i)}
      />

      <FinalRankingLinks runs={runs} />

      {runs.length === 0 ? (
        <EmptyState
          title="No scoring run yet"
          explanation="Runs appear here once a cohort has been scored against a frozen rubric."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Cohort</th>
              <th scope="col">Status</th>
              <th scope="col">Scored</th>
              <th scope="col">Ranked</th>
              <th scope="col">Shortlist</th>
              <th scope="col">Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.run_index_id} data-testid={`run-${run.run_index_id}`}>
                <td>#{run.run_index_id} (run {run.run_index})</td>
                <td>{run.cohort_key}</td>
                <td>{run.status}</td>
                <td>{run.submissions}</td>
                <td>
                  {run.ranked > 0
                    ? run.ranked
                    : <span style={{ color: 'var(--text-muted)' }}>not ranked</span>}
                </td>
                <td>{run.shortlist_status ?? '—'}</td>
                <td>{new Date(run.started_at).toLocaleString()}</td>
                <td>
                  {run.ranked > 0 ? (
                    <>
                      <Link to={`/review/runs/${run.run_index_id}`}>Review</Link>
                      {' · '}
                      <Link to={`/scoring/runs/${run.run_index_id}`}>Ranking</Link>
                    </>
                  ) : (
                    <span
                      style={{ color: 'var(--text-muted)' }}
                      title="Compute the ranking for this run before reviewing it."
                    >
                      nothing to review yet
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * One link per cohort that has been scored twice (E50): the final ranking is drawn from both
 * runs, so it is offered where both exist rather than beside either one.
 */
function FinalRankingLinks({ runs }: { runs: ScoringRun[] }) {
  const cohorts = new Map<string, Set<number>>()
  for (const r of runs) {
    if (r.ranked > 0) cohorts.set(r.cohort_key, new Set([...(cohorts.get(r.cohort_key) ?? []), r.run_index]))
  }
  const ready = [...cohorts].filter(([, idx]) => idx.has(1) && idx.has(2)).map(([k]) => k)
  if (ready.length === 0) return null
  return (
    <p style={{ fontSize: 13 }}>
      Final ranking (both runs):{' '}
      {ready.map((k, i) => (
        <span key={k}>{i > 0 && ' · '}<Link to={`/scoring/cohorts/${encodeURIComponent(k)}/final`}>{k}</Link></span>
      ))}
    </p>
  )
}
