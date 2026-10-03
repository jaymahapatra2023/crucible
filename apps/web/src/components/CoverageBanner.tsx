import type { DiscoveryCoverage } from '../lib/scoringApi.js'

/**
 * Whether this ranked field was evidenced evenly (E15-S04).
 *
 * Discovery feeds the principles and standards evaluators, so a cohort where some submissions
 * were described and some were not is a cohort scored on unequal context — against the same
 * rubric, in the same ranking, with nothing on screen saying so.
 *
 * Deliberately silent in two of the three states. A field where nobody was discovered is
 * consistent and therefore fair; one where everybody was is simply complete. Warning on either
 * would train a reviewer to ignore the warning that matters.
 */
export function CoverageBanner({ coverage }: { coverage?: DiscoveryCoverage }) {
  if (!coverage || !coverage.uneven) return null

  return (
    <p
      role="status"
      data-testid="coverage-uneven"
      style={{
        border: '1px solid var(--warn)',
        borderLeft: '4px solid var(--warn)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        margin: '0 0 16px',
        background: '#fdf9ef',
        color: 'var(--text)',
      }}
    >
      <strong style={{ color: 'var(--warn)' }}>
        This field was not evidenced evenly.
      </strong>{' '}
      {coverage.note}
    </p>
  )
}
