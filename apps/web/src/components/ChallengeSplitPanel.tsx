/**
 * The challenge breakdown of the shortlist (E07-S05).
 *
 * Always shown (acceptance 1), not surfaced only when something looks wrong: an organiser who
 * only ever sees this panel during a problem has no sense of what a normal split looks like.
 *
 * The median composites sit beside the shares because together they distinguish two very
 * different situations that produce the same lopsided table (acceptance 3): a challenge whose
 * teams did better work, and a challenge whose brief was simply easier to score well against.
 */
import type { SplitReport } from '../lib/scoringApi.js'

export function ChallengeSplitPanel({ split }: { split: SplitReport }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Split by challenge</h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        The top {split.shortlistSize} for review
        {split.shortlisted < split.shortlistSize
          && ` (${split.shortlisted} ranked so far)`}.
      </p>

      {split.advisory && (
        <p
          role="status"
          data-testid="split-advisory"
          style={{
            fontSize: 13, color: 'var(--warn)', border: '1px solid var(--warn)',
            borderRadius: 6, padding: 10, margin: '0 0 10px',
          }}
        >
          {split.advisory}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th scope="col">Challenge</th>
            <th scope="col">In review list</th>
            <th scope="col">Share</th>
            <th scope="col">Ranked</th>
            <th scope="col">Cohort</th>
            <th scope="col">Median composite</th>
            <th scope="col">Median in list</th>
            <th scope="col">Best rank</th>
          </tr>
        </thead>
        <tbody>
          {split.byChallenge.map((row) => (
            <tr key={row.challengeId}>
              <td>{row.challengeId}</td>
              <td data-testid={`split-count-${row.challengeId}`}>{row.inShortlist}</td>
              <td>{row.shareOfShortlistPct}%</td>
              <td>{row.ranked}</td>
              <td>
                {row.cohortSize}
                {row.belowFloor && (
                  <span
                    title="Below the normalisation floor: fidelity was scored absolutely."
                    style={{ color: 'var(--warn)' }}
                  >
                    {' '}(below floor)
                  </span>
                )}
              </td>
              <td>{row.medianComposite ?? '—'}</td>
              <td>{row.medianShortlisted ?? '—'}</td>
              <td>{row.bestRank ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
