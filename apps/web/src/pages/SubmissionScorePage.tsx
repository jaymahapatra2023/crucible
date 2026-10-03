/**
 * Everything recorded about one submission in one scoring run (E06-S02 … E06-S05).
 *
 * This is the page a reviewer opens when they want to know why a number is what it is, and the
 * page an appeal is answered from. Its organising rule: nothing is shown without what it was
 * derived from. Every criterion carries its evidence, the engineering score carries its
 * measurements, and the advisory signal carries the shares it was measured from.
 */
import { useParams } from 'react-router-dom'
import { getSubmissionScores, type SubmissionScores } from '../lib/scoringApi.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { ScoreCard, EvidenceList, ScoreBadge } from '../components/ScoreCard.js'
import { MetricInputsPanel } from '../components/MetricInputs.js'
import { OriginalityPanel } from '../components/OriginalityPanel.js'

export function SubmissionScorePage() {
  const { runId, submissionId } = useParams()
  const run = Number(runId)
  const submission = Number(submissionId)

  const { state, reload } = useAsyncData<SubmissionScores>(
    () => getSubmissionScores(run, submission),
    [run, submission],
  )

  if (state.status === 'loading') return <LoadingState label="Loading scores" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="Scores could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={reload}
      />
    )
  }

  const { criteria, principles, standards, originality, metrics } = state.data
  const unscored = criteria.filter((c) => c.raw_score === null).length

  return (
    <section>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>
          Submission {submission} · run {run}
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0' }}>
          {criteria.length} criteria
          {unscored > 0 && (
            <>
              {', '}
              <strong style={{ color: 'var(--warn)' }}>
                {unscored} without a score
              </strong>
              {' — excluded from the averages rather than counted as zero.'}
            </>
          )}
        </p>
      </header>

      {criteria.length === 0 ? (
        <EmptyState
          title="This submission has not been scored in this run"
          explanation="Scores appear once the run reaches this submission. A run that skipped it records why."
        />
      ) : (
        <>
          <MetricInputsPanel inputs={metrics} />

          <h2 style={{ fontSize: 15, marginTop: 20 }}>Criteria</h2>
          {criteria.map((score) => <ScoreCard key={score.id} score={score} />)}
        </>
      )}

      {principles.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, marginTop: 20 }}>Architectural principles</h2>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
            Adoption is a journey, so these are maturity levels rather than pass or fail.
          </p>
          {principles.map((p) => (
            <article key={p.principle_id} style={panel}>
              <header style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <ScoreBadge score={p.maturity} nonScore={p.non_score} />
                <strong style={{ fontSize: 13 }}>{p.code} — {p.name}</strong>
              </header>
              <p style={{ fontSize: 13, margin: '8px 0' }}>{p.rationale}</p>
              <EvidenceList evidence={p.evidence} />
            </article>
          ))}
        </>
      )}

      {standards.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, marginTop: 20 }}>Standards</h2>
          {standards.map((s) => (
            <article key={s.standard_id} style={panel}>
              <header style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <strong style={{
                  fontSize: 13,
                  color: s.compliance === 'COMPLIANT' ? 'var(--ok)'
                    : s.compliance === 'NON_COMPLIANT' ? 'var(--danger)'
                    : 'var(--warn)',
                }}>
                  {s.compliance ?? s.non_score ?? 'Not assessed'}
                </strong>
                <strong style={{ fontSize: 13 }}>{s.code} — {s.name}</strong>
              </header>
              <p style={{ fontSize: 13, margin: '8px 0' }}>{s.rationale}</p>
              <EvidenceList evidence={s.evidence} />
            </article>
          ))}
        </>
      )}

      <OriginalityPanel originality={originality} />
    </section>
  )
}

const panel = {
  border: '1px solid var(--border)', borderRadius: 6, padding: 12, marginBottom: 12,
} as const
