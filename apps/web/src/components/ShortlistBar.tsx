/**
 * Shortlist state and the finalise control (E08-S05).
 *
 * Finalising is refused while the cut band is unresolved, and the bar says so BEFORE the button
 * is pressed, naming the ranks that are blocking. A control that looks available and then
 * refuses teaches people to distrust the screen; one that explains what is missing gets the work
 * finished.
 */
import type { ShortlistState } from '../lib/reviewApi.js'

export function ShortlistBar({
  shortlist, onFinalise, busy, error,
}: {
  shortlist: ShortlistState
  onFinalise: () => void
  busy?: boolean
  error?: string
}) {
  const { status } = shortlist.shortlist
  const blocked = shortlist.blocking.length > 0

  return (
    <section
      data-testid="shortlist-bar"
      style={{
        border: '1px solid var(--border)', borderRadius: 6,
        padding: 10, marginBottom: 12, display: 'flex',
        gap: 16, alignItems: 'center', flexWrap: 'wrap',
      }}
    >
      <strong style={{ fontSize: 13 }}>
        Shortlist: {status === 'FINAL' ? 'final' : 'open'}
      </strong>

      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        <span data-testid="count-shortlisted">{shortlist.counts['SHORTLIST'] ?? 0}</span> shortlisted,{' '}
        <span data-testid="count-excluded">{shortlist.counts['EXCLUDE'] ?? 0}</span> excluded,{' '}
        <span data-testid="count-held">{shortlist.counts['HOLD'] ?? 0}</span> on hold
      </span>

      {status === 'FINAL' ? (
        <span style={{ fontSize: 13 }}>
          Locked by {shortlist.shortlist.finalised_by}
          {shortlist.shortlist.finalised_at
            && ` on ${new Date(shortlist.shortlist.finalised_at).toLocaleDateString()}`}
        </span>
      ) : (
        <button
          type="button"
          onClick={onFinalise}
          disabled={blocked || busy === true}
          title={blocked ? 'Decide every submission at the cut line first.' : undefined}
          style={{
            border: '1px solid var(--border)', background: 'var(--surface)',
            borderRadius: 6, padding: '4px 12px', font: 'inherit', fontSize: 13,
            cursor: blocked ? 'not-allowed' : 'pointer',
          }}
        >
          Finalise shortlist
        </button>
      )}

      {blocked && status !== 'FINAL' && (
        <p role="status" data-testid="finalise-blocked" style={{ fontSize: 12, color: 'var(--warn)', margin: 0, flexBasis: '100%' }}>
          {shortlist.blocking.length} submission(s) at the cut line still need a decision
          (rank{shortlist.blocking.length === 1 ? '' : 's'}{' '}
          {shortlist.blocking.map((b) => b.rank_global).join(', ')}). These are the ones where
          your judgement changes the outcome, so the shortlist cannot be locked until each is
          decided.
        </p>
      )}

      {error && (
        <p role="alert" style={{ fontSize: 12, color: 'var(--danger)', margin: 0, flexBasis: '100%' }}>
          {error}
        </p>
      )}
    </section>
  )
}
