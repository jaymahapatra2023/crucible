/**
 * The ranking for a scoring run (E07-S03 … E07-S06).
 *
 * What this page deliberately does NOT have: a select button, a shortlist checkbox, or anything
 * that marks a team as chosen. It ranks, it splits, it flags; a person decides (P0 constraint 1).
 *
 * Everything that qualifies a position travels with it: whether the ranking is still current,
 * whether the cohort was too small to normalise, how much of the rubric could be scored, and
 * which dimensions could not. A position shown without its caveats reads as a verdict.
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  getBorderline, getRanking, getSplit,
  type CutBandReport, type Ranking, type SplitReport,
} from '../lib/scoringApi.js'
import { DownloadButton } from '../components/DownloadButton.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { ChallengeSplitPanel } from '../components/ChallengeSplitPanel.js'
import { GateBanner } from '../components/GateBanner.js'
import { CoverageBanner } from '../components/CoverageBanner.js'
import { getGate, type GateResponse } from '../lib/calibrationApi.js'
import { CutBandPanel } from '../components/CutBandPanel.js'

interface PageData {
  ranking: Ranking
  split: SplitReport
  band: CutBandReport
  gate: GateResponse
}

export function RankingPage() {
  const { runId } = useParams()
  const run = Number(runId)
  const [showPartialOnly, setShowPartialOnly] = useState(false)

  const { state, reload } = useAsyncData<PageData>(
    async () => {
      const [ranking, split, band, gate] = await Promise.all([
        getRanking(run), getSplit(run), getBorderline(run), getGate(),
      ])
      return { ranking, split, band, gate }
    },
    [run],
  )

  if (state.status === 'loading') return <LoadingState label="Loading ranking" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Ranking could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={reload}
      />
    )
  }

  const { ranking, split, band, gate } = state.data
  const { ranked, fallbackChallenges, partialCount, stale, snapshot } = ranking
  const rows = showPartialOnly ? ranked.filter((r) => r.partial) : ranked

  return (
    <section>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Ranking · run {run}</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0' }}>
          An ordering for review. Nothing here selects or eliminates anyone.
          {snapshot && ` Computed ${new Date(snapshot.computed_at).toLocaleString()}.`}
          {' '}
          <DownloadButton
            path={`/scoring/runs/${run}/ranking.csv`}
            filename={`ranking-run-${run}.csv`}
            label="Export CSV"
            testId="export-ranking"
          />
        </p>
      </header>

      {/* Whether this ordering may be acted on at all (E11-S03). */}
      <GateBanner gate={gate} />
      <CoverageBanner coverage={ranking.discoveryCoverage} />

      {stale && (
        <p role="status" data-testid="stale-warning" style={warnBox}>
          Scores have changed since this ranking was computed, so these positions may no longer
          reflect them. Recompute the ranking before acting on it.
        </p>
      )}

      {partialCount > 0 && (
        <p role="status" style={{ fontSize: 13, color: 'var(--warn)' }}>
          {partialCount} of {ranked.length} composites are partial — at least one dimension could
          not be scored, so they were ranked on less evidence than the rest.{' '}
          <label style={{ marginLeft: 8, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={showPartialOnly}
              onChange={(e) => setShowPartialOnly(e.target.checked)}
            />{' '}
            show only these
          </label>
        </p>
      )}

      {fallbackChallenges.length > 0 && (
        <p role="status" style={{ fontSize: 13, color: 'var(--warn)' }}>
          Challenge {fallbackChallenges.join(', ')} had too few submissions to normalise fidelity
          within the cohort. Raw scores were used instead, and those positions need a human eye.
        </p>
      )}

      <ChallengeSplitPanel split={split} />
      <CutBandPanel report={band} runId={run} />

      <h2 style={{ fontSize: 15 }}>Full ranking</h2>
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing to rank"
          explanation="A ranking appears once submissions in this run have scores and the ranking has been computed."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Submission</th>
              <th scope="col">Challenge</th>
              <th scope="col">In challenge</th>
              <th scope="col">Composite</th>
              <th scope="col">Fidelity</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.submission_id}>
                <td>
                  {r.rank_global}
                  {r.tied && (
                    <span title="Shares this composite with another submission"
                      style={{ color: 'var(--warn)' }}> (tied)</span>
                  )}
                </td>
                <td>
                  <Link to={`/scoring/runs/${run}/submissions/${r.submission_id}`}>
                    {r.team_name ?? r.submission_id}
                  </Link>
                </td>
                <td>{r.challenge_id}</td>
                <td>{r.rank_in_challenge}</td>
                <td>{Number(r.composite).toFixed(1)}</td>
                <td>
                  {r.fidelity_normalised === null ? (
                    <span style={{ color: 'var(--warn)' }}>not scored</span>
                  ) : (
                    <>
                      {Number(r.fidelity_normalised).toFixed(1)}
                      {/* The raw score is always kept for appeals (E07-S02 acceptance 3). */}
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        {' '}(raw {r.fidelity_raw === null ? '—' : Number(r.fidelity_raw).toFixed(1)})
                      </span>
                    </>
                  )}
                </td>
                <td>
                  {Math.round(Number(r.weight_covered) * 100)}%
                  {r.missing_dimensions.length > 0 && (
                    <span style={{ color: 'var(--warn)', fontSize: 11 }}>
                      {' '}· no {r.missing_dimensions.map((d) => d.replace(/_/g, ' ').toLowerCase()).join(', ')}
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

const warnBox = {
  fontSize: 13, color: 'var(--warn)', border: '1px solid var(--warn)',
  borderRadius: 6, padding: 10, marginBottom: 10,
} as const
