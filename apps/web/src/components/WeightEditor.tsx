import { useState } from 'react'
import {
  dimensionTotal, sumsToOne, type Criterion, type Dimension,
} from '../lib/rubricApi.js'

/**
 * Criterion weights for one dimension (E02-S06 acceptance 2).
 *
 * Shows the running total continuously and states plainly when it is not 1.0. The number is not
 * silently normalised: the committee is deciding relative importance, and quietly rescaling
 * their input would mean the rubric does not say what they think it says.
 */
export function WeightEditor({
  dimension,
  criteria,
  disabled,
  onSave,
}: {
  dimension: Dimension
  criteria: Criterion[]
  disabled: boolean
  onSave: (weights: Record<string, number>) => Promise<void>
}) {
  const inDimension = criteria.filter((c) => c.dimension === dimension)
  const [draft, setDraft] = useState<Record<string, number>>(
    () => Object.fromEntries(inDimension.map((c) => [c.criterionId, c.weight])),
  )
  const [saving, setSaving] = useState(false)

  if (inDimension.length === 0) return null

  const total = Object.values(draft).reduce((a, b) => a + b, 0)
  const balanced = sumsToOne(total)
  const persistedTotal = dimensionTotal(criteria, dimension)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 8 }}>
      <table>
        <caption style={{ textAlign: 'left', paddingBottom: 6, fontWeight: 600 }}>
          Weights within this dimension
        </caption>
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col" style={{ width: 140 }}>Weight</th>
          </tr>
        </thead>
        <tbody>
          {inDimension.map((c) => (
            <tr key={c.criterionId}>
              <td>{c.name}</td>
              <td>
                <input
                  type="number" min={0} max={1} step={0.01} disabled={disabled}
                  aria-label={`Weight for ${c.name}`}
                  value={draft[c.criterionId] ?? 0}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [c.criterionId]: Number(e.target.value) }))}
                  style={{ width: 100, padding: '4px 6px', font: 'inherit' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" style={{ textTransform: 'none' }}>Total</th>
            <td>
              <strong
                data-testid={`total-${dimension}`}
                style={{ color: balanced ? 'var(--ok)' : 'var(--danger)' }}
              >
                {total.toFixed(2)}
              </strong>
              {!balanced && (
                <span style={{ color: 'var(--danger)', marginLeft: 8 }}>must be 1.00</span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>

      {!disabled && (
        <button
          type="button"
          disabled={saving || total === persistedTotal}
          onClick={async () => {
            setSaving(true)
            try {
              await onSave(draft)
            } finally {
              setSaving(false)
            }
          }}
          style={{
            marginTop: 8, padding: '6px 12px', borderRadius: 6, font: 'inherit',
            border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save weights'}
        </button>
      )}
    </div>
  )
}
