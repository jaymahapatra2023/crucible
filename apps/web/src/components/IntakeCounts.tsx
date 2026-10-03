import type { IntakeDashboard } from '../lib/intakeApi.js'

/**
 * Intake totals (E03-S05 acceptance 1).
 *
 * Every figure here is a backend count (P5.7). A dashboard whose numbers came from the length of
 * a page of results would under-report exactly when it matters most — near the deadline, with
 * the most submissions in flight.
 */
export function IntakeCounts({ dashboard }: { dashboard: IntakeDashboard }) {
  const { totals } = dashboard
  const tiles = [
    { label: 'Submitted', value: totals.total, tone: 'var(--text)' },
    { label: 'Valid', value: totals.valid, tone: 'var(--ok)' },
    { label: 'Awaiting check', value: totals.pending, tone: 'var(--text-muted)' },
    { label: 'Private', value: totals.private, tone: 'var(--danger)' },
    { label: 'Unreachable', value: totals.unreachable, tone: 'var(--danger)' },
    { label: 'Rejected', value: totals.rejected, tone: 'var(--danger)' },
  ]

  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12, marginBottom: 20,
      }}
    >
      {tiles.map((tile) => (
        <div
          key={tile.label}
          style={{
            border: '1px solid var(--border)', borderRadius: 8,
            padding: '12px 14px', background: 'var(--surface)',
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
            {tile.label}
          </div>
          <div
            data-testid={`count-${tile.label.toLowerCase().replace(/\s+/g, '-')}`}
            style={{ fontSize: 26, fontWeight: 600, color: tile.tone, lineHeight: 1.2 }}
          >
            {tile.value}
          </div>
        </div>
      ))}
    </div>
  )
}
