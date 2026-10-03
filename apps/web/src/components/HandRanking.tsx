import { useState } from 'react'
import type { GoldenSetDetail, RankingRow } from '../lib/calibrationApi.js'

/**
 * One person's hand ranking (E18-S03).
 *
 * Independence is the entire value of the exercise, and the server enforces it: while the set is
 * OPEN a caller is shown only their own ordering. This surface must not undo that by displaying
 * anyone else's, so it shows who has ranked and nothing about how.
 *
 * E11-S01 also requires the hand rankings to exist BEFORE any machine scoring. That ordering is
 * enforced server-side; here it is simply stated, because a rule a person understands is one
 * they are less likely to try to work around.
 */
export function HandRanking({
  detail, mine, busy, onRecord,
}: {
  detail: GoldenSetDetail
  mine: RankingRow[]
  busy: boolean
  onRecord: (positions: Array<{ entryId: number; position: number }>) => void
}) {
  const [order, setOrder] = useState<Record<number, string>>(() =>
    Object.fromEntries(detail.entries.map((e) => {
      const existing = mine.find((r) => r.entry_id === e.entry_id)
      return [e.entry_id, existing ? String(existing.position) : '']
    })))

  const positions = detail.entries
    .map((e) => ({ entryId: e.entry_id, position: Number(order[e.entry_id]) }))
    .filter((p) => Number.isInteger(p.position) && p.position >= 1)

  // A ranker who ordered six of eight has not produced an ordering, and a partial one would be
  // compared against a complete machine ranking as though it were whole.
  const complete = positions.length === detail.entries.length
  const distinct = new Set(positions.map((p) => p.position)).size === positions.length

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 16,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Your ranking</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Order these best to worst, before any machine scores them. You are shown your own
        ordering only — seeing another ranker's would destroy the independence the comparison
        depends on.
      </p>

      <p style={{ color: 'var(--text-muted)' }}>
        Ranked so far: {detail.readiness.rankers.length === 0
          ? 'nobody'
          : detail.readiness.rankers.join(', ')}.
        {detail.readiness.rankers.length < 2
          && ' At least two people are needed, independently.'}
      </p>

      <table>
        <thead>
          <tr>
            <th scope="col" style={{ width: 90 }}>Position</th>
            <th scope="col">Repository</th>
            <th scope="col">You expect</th>
          </tr>
        </thead>
        <tbody>
          {detail.entries.map((entry) => (
            <tr key={entry.entry_id}>
              <td>
                <input
                  type="number" min={1} max={detail.entries.length}
                  aria-label={`Position for ${entry.label}`}
                  value={order[entry.entry_id] ?? ''}
                  disabled={busy}
                  onChange={(e) =>
                    setOrder((o) => ({ ...o, [entry.entry_id]: e.target.value }))}
                  style={{ width: 70, padding: '4px 6px', font: 'inherit' }}
                />
              </td>
              <td>
                {entry.label}
                {entry.edge_case && (
                  <span style={{ color: 'var(--text-muted)' }}> · {entry.edge_case}</span>
                )}
              </td>
              <td style={{ color: 'var(--text-muted)' }}>{entry.expected_band}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {!distinct && positions.length > 0 && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          Two repositories share a position. An ordering has to be an ordering.
        </p>
      )}
      {!complete && positions.length > 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          {detail.entries.length - positions.length} still to place. A partial ranking would be
          compared against a complete machine one as though it were whole.
        </p>
      )}

      <button
        type="button"
        disabled={busy || !complete || !distinct}
        onClick={() => onRecord(positions)}
      >
        Record my ranking
      </button>
    </section>
  )
}
