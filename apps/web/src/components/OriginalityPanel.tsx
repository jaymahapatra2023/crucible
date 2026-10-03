/**
 * The advisory inventiveness signal (E06-S05 acceptance 2, re-anchored in E35).
 *
 * The word ADVISORY is on the page, not just in the schema. This dimension carries a low weight
 * and is barred from being the sole reason anyone falls below the cut, and a reviewer who does
 * not know that will read a level 1 as damning.
 *
 * The measurements below are shown as **context, not as the score**. They used to be the
 * finding — the dimension asked how much of the work was the team's own — and they are now the
 * bound on a different question: whether the approach shows a point of view. A scaffold share is
 * a fact about a repository, not a fact about a team, and on this dimension it is not a fact
 * about the idea either.
 */
import type { OriginalityAssessment } from '../lib/scoringApi.js'

export function OriginalityPanel({ originality }: { originality: OriginalityAssessment | null }) {
  if (!originality) {
    return (
      <>
        <h2 style={{ fontSize: 15, marginTop: 20 }}>Inventiveness</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          The advisory inventiveness signal did not run for this submission, so the dimension was
          left out of the composite rather than scored zero.
        </p>
      </>
    )
  }

  return (
    <>
      <h2 style={{ fontSize: 15, marginTop: 20 }}>
        Inventiveness{' '}
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--warn)',
          border: '1px solid var(--warn)', borderRadius: 3, padding: '1px 5px',
        }}>
          ADVISORY
        </span>
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        Whether the approach shows a considered point of view — not how much of the code the team
        wrote themselves. Carries a low weight, and can never be the sole reason a submission
        falls below the cut line.
      </p>

      <article style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
        <header style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <strong style={{ fontSize: 18 }}>
            {originality.level ?? '—'}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> / 4</span>
          </strong>
          {originality.non_score && (
            <span style={{ color: 'var(--warn)', fontSize: 13 }}>{originality.non_score}</span>
          )}
        </header>

        <p style={{ fontSize: 13, margin: '8px 0' }}>{originality.rationale}</p>

        <dl style={{ display: 'flex', gap: 20, fontSize: 13, margin: '8px 0' }}>
          <div>
            <dt style={{ fontSize: 11, color: 'var(--text-muted)' }}>Scaffold and config</dt>
            <dd style={{ margin: 0, fontWeight: 600 }}>{originality.boilerplate_share_pct.toFixed(1)}%</dd>
          </div>
          <div>
            <dt style={{ fontSize: 11, color: 'var(--text-muted)' }}>Team-written lines</dt>
            <dd style={{ margin: 0, fontWeight: 600 }}>{originality.substantive_lines}</dd>
          </div>
        </dl>

        {/* Labelled as context so a reviewer does not read the percentage as the verdict. It
            bounds the score in one direction only: no substantive code means no approach to
            judge. Above that floor it says nothing about the idea. */}
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          These measure how the repository was assembled, not how good the idea is. A high
          scaffold share is not a criticism: choosing a framework and spending the time on what
          matters is good engineering.
        </p>

        {originality.templates.length > 0 && (
          <p style={{ fontSize: 12, margin: '8px 0' }}>
            <strong>Recognised generators:</strong>{' '}
            {originality.templates.map((t) => `${t.name} (${t.matchedOn})`).join(', ')}
          </p>
        )}

        {originality.provenance_flags.length > 0 && (
          <ul style={{ fontSize: 12, paddingLeft: 18, margin: '8px 0 0' }}>
            {originality.provenance_flags.map((f) => <li key={f.code}>{f.message}</li>)}
          </ul>
        )}

        {originality.observations.length > 0 && (
          <ul style={{ fontSize: 12, paddingLeft: 18, margin: '8px 0 0' }}>
            {originality.observations.map((o) => <li key={o}>{o}</li>)}
          </ul>
        )}
      </article>
    </>
  )
}
