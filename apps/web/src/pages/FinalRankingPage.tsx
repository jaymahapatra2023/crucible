import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { computeFinalRanking, getFinalRanking, type FinalRankedRow, type FinalRanking } from '../lib/finalRankingApi.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { DownloadButton } from '../components/DownloadButton.js'

/**
 * The final ranking of a cohort (E50): both runs combined into one list.
 *
 * The number that decides is the weighted mean of two independent runs, but the page never
 * shows only that number: both runs' composites sit beside it, and a row where the runs
 * disagree — by more than the threshold, or about which side of the cut it falls — is marked
 * for a human. Averaging is how the list is made; it is not allowed to hide anything.
 */
export function FinalRankingPage() {
  const { cohortKey = '' } = useParams()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const { state } = useAsyncData<FinalRanking>(() => getFinalRanking(cohortKey), [cohortKey, key])

  if (state.status === 'loading') return <LoadingState label="Loading the final ranking" />
  if (state.status === 'error') {
    return <ErrorState title="The final ranking could not be loaded" message={state.error.message} onRetry={() => setKey((k) => k + 1)} />
  }
  const view = state.data
  const canCompute = view.runs.run1IndexId !== null && view.runs.run2IndexId !== null

  async function compute() {
    setBusy(true); setFailure(null)
    try { await computeFinalRanking(cohortKey); setKey((k) => k + 1) } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The final ranking could not be computed.')
    } finally { setBusy(false) }
  }

  return (
    <section>
      <Header view={view} cohortKey={cohortKey} busy={busy} canCompute={canCompute} onCompute={() => void compute()} />
      {!canCompute && (
        <p role="status" style={{ color: 'var(--warn)' }}>
          This cohort has not been scored twice yet. Both runs must be scored and ranked first.
        </p>
      )}
      {view.stale && (
        <p role="alert" style={{ color: 'var(--warn)' }}>
          A run's ranking was recomputed after this list was made. Recompute before relying on it.
        </p>
      )}
      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {view.ranked.length === 0 ? (
        <EmptyState title="No final ranking yet" explanation="Compute it once both runs are ranked." />
      ) : (
        <div className="table-wrap">
          <table aria-label="Final ranking">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Team</th>
                <th scope="col">Challenge</th>
                <th scope="col">Final</th>
                <th scope="col">Run 1</th>
                <th scope="col">Run 2</th>
                <th scope="col">Δ</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {view.ranked.map((r) => <FinalRow key={r.submission_id} r={r} cutLine={view.snapshot?.cut_line_used ?? null} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

const NOTES: Array<[keyof FinalRankedRow, string]> = [
  ['disagreement', 'runs disagree'], ['single_run', 'scored in one run only'],
  ['in_cut_band', 'at the cut line'], ['partial', 'partial evidence'],
]
const num = (n: number | null): string => (n === null ? '—' : n.toFixed(1))

function FinalRow({ r, cutLine }: { r: FinalRankedRow; cutLine: number | null }) {
  const notes = NOTES.filter(([key]) => r[key] === true).map(([, text]) => text)
  return (
    <tr data-cut={cutLine !== null && r.rank_global <= cutLine ? 'in' : 'out'}
      style={{ background: r.disagreement ? 'rgba(138,106,31,0.08)' : undefined }}>
      <td>{r.rank_global}{r.tied && <span title="tied on composite"> =</span>}</td>
      <td>{r.team_name ?? `#${r.submission_id}`}</td>
      <td>#{r.challenge_id} · {r.rank_in_challenge}{ordinal(r.rank_in_challenge)}</td>
      <td><strong>{num(r.composite_final)}</strong></td>
      <td>{num(r.composite_run1)}</td>
      <td>{num(r.composite_run2)}</td>
      <td>{num(r.delta)}</td>
      {/* Written out, never colour alone (P5.4). */}
      <td style={{ fontSize: 12, color: r.disagreement ? 'var(--warn)' : 'var(--text-muted)' }}>{notes.join(' · ')}</td>
    </tr>
  )
}

function Header({ view, cohortKey, busy, canCompute, onCompute }: {
  view: FinalRanking; cohortKey: string; busy: boolean; canCompute: boolean; onCompute: () => void
}) {
  const { run1IndexId, run2IndexId } = view.runs
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Final ranking · {cohortKey}</h1>
        {view.snapshot && (
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            weights run 1 {view.snapshot.weights['1']} · run 2 {view.snapshot.weights['2']} · computed{' '}
            {new Date(view.snapshot.computed_at).toLocaleString()}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" disabled={busy || !canCompute} onClick={onCompute}>
            {view.snapshot ? 'Recompute' : 'Compute final ranking'}
          </button>
          {view.snapshot && (
            <DownloadButton path={`/scoring/cohorts/${encodeURIComponent(cohortKey)}/final.csv`}
              filename={`final-ranking-${cohortKey}.csv`} label="Export CSV" testId="export-final" />
          )}
        </span>
      </header>
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        One list from two runs: the weighted mean of each submission's composites, ranked with the
        same tie rule as each run. Rows where the runs disagree are marked; a human looks at those.
        {' '}Per-run detail: {run1IndexId !== null && <Link to={`/scoring/runs/${run1IndexId}`}>run 1</Link>}
        {run1IndexId !== null && run2IndexId !== null && ' · '}
        {run2IndexId !== null && <Link to={`/scoring/runs/${run2IndexId}`}>run 2</Link>}
      </p>
    </>
  )
}

const ordinal = (n: number): string => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th')
