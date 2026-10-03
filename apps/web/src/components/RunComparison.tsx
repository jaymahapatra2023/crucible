/**
 * Where the two scoring runs disagreed (E08-S02 acceptance 5).
 *
 * Only the criteria that differ. Crucible scores every cohort twice so disagreement is visible;
 * listing all criteria twice would bury the handful that disagree among identical rows, which is
 * how a real signal gets lost inside a complete one.
 *
 * A score against a non-score counts as a difference. "Scored 3" and "could not be evidenced"
 * are a disagreement about the work even though only one is a number.
 */
import type { RunDifference } from '../lib/reviewApi.js'

export function RunComparison({ differences }: { differences: RunDifference[] }) {
  if (differences.length === 0) {
    return (
      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        The two runs agreed on every criterion for this team, or only one run has been scored.
      </p>
    )
  }

  return (
    <section>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>
        Where the two runs disagreed — {differences.length} criteri
        {differences.length === 1 ? 'on' : 'a'}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        Both runs saw the same evidence and used the same rubric. A gap here measures how
        reliably this submission could be judged — not how good it is.
      </p>

      {differences.map((d) => (
        <article
          key={d.criterionId}
          data-testid={`difference-${d.criterionId}`}
          style={{ border: '1px solid var(--warn)', borderRadius: 6, padding: 10, marginBottom: 8 }}
        >
          <header style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {d.dimension.replace(/_/g, ' ').toLowerCase()}
          </header>

          <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
            <Side label={`Run ${d.runA.runIndex}`} side={d.runA} />
            <Side label={`Run ${d.runB.runIndex}`} side={d.runB} />
          </div>
        </article>
      ))}
    </section>
  )
}

function Side({ label, side }: { label: string; side: RunDifference['runA'] }) {
  return (
    <div style={{ flex: 1 }}>
      <strong style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</strong>
      <p style={{ margin: '2px 0', fontSize: 16, fontWeight: 600 }}>
        {side.rawScore === null
          // Never rendered as a zero or a blank: the reason it has no number is the finding.
          ? <span style={{ fontSize: 13, color: 'var(--warn)' }}>{label20(side.nonScore)}</span>
          : <>{side.rawScore}<span style={{ fontSize: 12, color: 'var(--text-muted)' }}> / 4</span></>}
      </p>
      <p style={{ fontSize: 12, margin: 0 }}>{side.rationale}</p>
    </div>
  )
}

function label20(nonScore: string | null): string {
  switch (nonScore) {
    case 'INSUFFICIENT_EVIDENCE': return 'Not enough evidence'
    case 'SCORING_FAILED': return 'Scoring failed'
    case 'NOT_APPLICABLE': return 'Not applicable'
    default: return 'Not scored'
  }
}
