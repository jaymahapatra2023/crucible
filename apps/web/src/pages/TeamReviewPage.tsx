/**
 * Everything known about one team, for the person deciding (E08-S02, E08-S03, E08-S04).
 *
 * The page a reviewer opens to answer "can I defend this placement?", and the page an appeal is
 * answered from. Its rule: nothing is shown without what it was derived from, and nothing that
 * qualifies a number is left off the screen it appears on.
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  dismissReviewFlag, getDecisionHistory, getShortlist, getTeamDetail, recordDecision,
  type DecisionHistoryEntry, type ShortlistState, type TeamDetail,
} from '../lib/reviewApi.js'
import {
  fetchArtifacts, getArtifacts, type SubmissionArtifact,
} from '../lib/artifactApi.js'
import { ArtifactPanel } from '../components/ArtifactPanel.js'
import { getUser } from '../lib/session.js'
import { DownloadButton } from '../components/DownloadButton.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { FlagList } from '../components/FlagList.js'
import { DecisionPanel, type Decision } from '../components/DecisionPanel.js'
import { RunComparison } from '../components/RunComparison.js'
import { ScoreCard } from '../components/ScoreCard.js'
import { ProbeSummary } from '../components/ProbeSummary.js'

interface PageData {
  detail: TeamDetail
  shortlist: ShortlistState | null
  history: DecisionHistoryEntry[]
  /** Empty rather than fatal: a submission nobody has fetched documents for still reviews. */
  artifacts: SubmissionArtifact[]
}

export function TeamReviewPage() {
  const { runId, submissionId } = useParams()
  const run = Number(runId)
  const submission = Number(submissionId)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { state } = useAsyncData<PageData>(
    async () => ({
      detail: await getTeamDetail(run, submission),
      shortlist: await getShortlist(run).catch(() => null),
      // Empty rather than fatal: a team nobody has decided about has no history, and a reader
      // who cannot see the history can still see the evidence.
      history: await getDecisionHistory(run, submission).catch(() => []),
      artifacts: await getArtifacts(submission).catch(() => [] as SubmissionArtifact[]),
    }),
    [run, submission, reload],
  )

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      setReload((n) => n + 1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading the evidence" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="This team could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={() => setReload((n) => n + 1)}
      />
    )
  }

  const { detail, shortlist, history, artifacts } = state.data
  const unscored = detail.criteria.filter((c) => c.raw_score === null).length

  return (
    <section>
      <header style={{ marginBottom: 12 }}>
        <Link to={`/review/runs/${run}`} style={{ fontSize: 12 }}>← Back to the ranked field</Link>
        {' · '}
        <Link to={`/review/runs/${run}/coach-sheets`} style={{ fontSize: 12 }}>Coach sheets</Link>
        <h1 style={{ fontSize: 19, margin: '4px 0 0' }}>
          {detail.submission?.team_name ?? `Submission ${submission}`}
          {detail.ranking && (
            <span style={{ color: 'var(--text-muted)', fontSize: 14, fontWeight: 400 }}>
              {' '}· rank {detail.ranking.rank_global} · composite{' '}
              {Number(detail.ranking.composite).toFixed(1)}
            </span>
          )}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          {detail.submission && (
            <a href={detail.submission.repo_url} target="_blank" rel="noreferrer">
              {detail.submission.repo_url}
            </a>
          )}
          {detail.submission?.locked_commit_sha && (
            <span style={{ fontFamily: 'monospace' }}>
              {' '}@ {detail.submission.locked_commit_sha.slice(0, 12)}
            </span>
          )}
          {unscored > 0 && (
            <>
              {' · '}
              <strong style={{ color: 'var(--warn)' }}>
                {unscored} criteri{unscored === 1 ? 'on' : 'a'} without a score
              </strong>
              {' — excluded from the averages rather than counted as zero.'}
            </>
          )}
        </p>
        <TeamPlaceLine place={detail.place} />
      </header>

      <ArtifactPanel
        artifacts={artifacts} busy={busy}
        // Fetching reaches out to an address the team chose, so only an organiser may start it.
        // A reviewer sees whatever was read without being able to cause a request.
        onFetch={mayFetch() ? () => void act(() => fetchArtifacts(submission)) : null}
      />

      {/* What they built, before how it scored. A reviewer who has read the description
          judges the score against a picture of the work rather than the other way round. */}
      <p style={{ marginTop: 0 }}>
        <Link to={`/submissions/${submission}/discovery`}>
          What this team built →
        </Link>
        <span style={{ color: 'var(--text-muted)' }}>
          {' '}Its API surface, data model, capabilities, stack and security observations.
        </span>
      </p>

      {actionError && (
        <p role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{actionError}</p>
      )}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <div>
          <DimensionTable dimensions={detail.dimensions} />
          <h2 style={{ fontSize: 15, marginTop: 20 }}>Criteria</h2>
          {detail.criteria.map((c) => <ScoreCard key={c.id} score={c} />)}
          <RunComparison differences={detail.runDifferences} />
        </div>

        <aside>
          <DecisionPanel
            existing={detail.decision}
            history={history}
            locked={shortlist?.shortlist.status === 'FINAL'}
            busy={busy}
            onDecide={(decision: Decision, reason: string) =>
              void act(() => recordDecision(run, submission, decision, reason))}
          />

          <div style={{ marginTop: 16 }}>
            <FlagList
              flags={detail.flags}
              busy={busy}
              onDismiss={(code, reason) =>
                void act(() => dismissReviewFlag(run, submission, code, reason))}
            />
          </div>

          <div style={{ marginTop: 16 }}>
            <ProbeSummary probe={detail.probe} provenance={detail.provenance} />
          </div>

          <section style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
            <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Record</h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
              Everything Crucible holds about this team as one document: the rubric it was judged
              against, every score with its evidence, the caveats raised, and the decision taken.
              Readable without access to this system.
            </p>
            <DownloadButton
              path={`/governance/runs/${run}/appeal/${submission}`}
              filename={`evaluation-record-${submission}.md`}
              label="Download the evaluation record"
              testId="appeal-packet-link"
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Generating one is itself recorded in the audit log.
            </p>
          </section>
        </aside>
      </div>
    </section>
  )
}

/** The five dimensions with the weight each carried (E08-S01 acceptance 1). */
function DimensionTable({ dimensions }: { dimensions: TeamDetail['dimensions'] }) {
  return (
    <section>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Dimensions</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Dimension</th>
            <th scope="col">Score</th>
            <th scope="col">Weight</th>
            <th scope="col">Criteria scored</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map((d) => (
            <tr key={d.dimension}>
              <td>{d.dimension.replace(/_/g, ' ').toLowerCase()}</td>
              <td data-testid={`dimension-${d.dimension}`}>
                {d.score === null
                  ? <span style={{ color: 'var(--warn)' }}>not scored</span>
                  : Number(d.score).toFixed(1)}
              </td>
              <td>{Math.round(Number(d.weight) * 100)}%</td>
              <td>
                {d.scored_count} of {d.total_count}
                {d.data_quality === 'PARTIAL' && (
                  <span style={{ color: 'var(--warn)' }}> · partial</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * Where they sat and who coached them (E27-S03 acceptance 4).
 *
 * A reviewer answering an appeal is reconstructing the day, and the room is part of it. A coach
 * named here is also the one conflict this page can show: a coach helped produce the work being
 * judged, and `rosterReadiness` warns about it only where the coach is also a Crucible reviewer.
 *
 * Renders NOTHING when the roster never placed the team. An "unknown room" line would be this
 * page inventing a fact to fill a field, which is the opposite of what it is for.
 */
function TeamPlaceLine({ place }: { place: TeamDetail['place'] }) {
  if (place === null || (place.roomLabel === null && place.coachName === null)) return null

  const parts = [
    place.roomLabel === null ? null : `Worked in ${place.roomLabel}`,
    place.coachName === null ? null : `coached by ${place.coachName}`,
  ].filter((part): part is string => part !== null)

  return (
    <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '2px 0 0' }}>
      {parts.join(' · ')}
    </p>
  )
}

/**
 * Who may cause an outbound request to an address the team chose.
 *
 * Organiser and above. A reviewer reads whatever was fetched without being able to make the
 * system reach out on an entrant's instruction — the same split the route enforces, stated here
 * so the control is absent rather than present-and-refused.
 */
function mayFetch(): boolean {
  const role = getUser()?.role
  return role === 'organiser' || role === 'admin'
}
