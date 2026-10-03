import type { Criterion } from '../lib/rubricApi.js'
import { SourceRefLink } from './SourceRefLink.js'

/**
 * One criterion as a reviewer sees it (E02-S06 acceptance 3 and 4).
 *
 * The source reference and the quality-gate notes are shown inline rather than behind a click:
 * a reviewer weighting a criterion needs to know both where it came from and whether the gate
 * thought it was scoreable, at the moment they are deciding.
 */
export function CriterionCard({
  criterion,
  challengeId,
}: {
  criterion: Criterion
  /** Needed to resolve the criterion's source_ref back to the brief passage it cites. */
  challengeId: string
}) {
  const flagged = criterion.needsRewrite === true

  return (
    <article
      style={{
        border: `1px solid ${flagged ? 'var(--warn)' : 'var(--border)'}`,
        borderLeftWidth: flagged ? 4 : 1,
        borderRadius: 8,
        padding: 14,
        marginBottom: 12,
        background: 'var(--surface)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{criterion.name}</h3>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          weight {(criterion.weight * 100).toFixed(0)}%
        </span>
        {flagged && (
          <span
            role="status"
            style={{
              marginLeft: 'auto', background: '#fdf5e3', color: 'var(--warn)',
              border: '1px solid var(--warn)', borderRadius: 999, padding: '1px 10px', fontSize: 12,
            }}
          >
            Needs rewrite
          </span>
        )}
      </header>

      <p style={{ margin: '8px 0' }}>{criterion.description}</p>

      <p style={{ margin: '8px 0' }}>
        <strong>What a reader will look for:</strong> {criterion.evidenceSpec}
      </p>

      {criterion.sourceRef && (
        <div style={{ margin: '8px 0', color: 'var(--text-muted)' }}>
          <strong>From the brief:</strong>{' '}
          <SourceRefLink challengeId={challengeId} sourceRef={criterion.sourceRef} />
        </div>
      )}

      {flagged && criterion.gateNotes && criterion.gateNotes.length > 0 && (
        <div
          style={{
            background: '#fdf5e3', border: '1px solid var(--warn)',
            borderRadius: 6, padding: '8px 10px', margin: '10px 0',
          }}
        >
          <strong style={{ display: 'block', color: 'var(--warn)', marginBottom: 4 }}>
            The quality gate could not confirm this is scoreable
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {criterion.gateNotes.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        </div>
      )}

      <details>
        <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>Score anchors</summary>
        <table style={{ marginTop: 8 }}>
          <tbody>
            {(['0', '1', '2', '3', '4'] as const).map((level) => (
              <tr key={level}>
                <th scope="row" style={{ width: 40, textAlign: 'right', textTransform: 'none' }}>
                  {level}
                </th>
                <td>{criterion.anchors[level]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </article>
  )
}
