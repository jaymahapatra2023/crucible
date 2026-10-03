import { useState } from 'react'
import { DIMENSIONS, DIMENSION_LABELS, sumsToOne, type Dimension } from '../lib/rubricApi.js'

/**
 * How much each dimension counts towards the composite (E02-S06, E07-S02).
 *
 * The single most consequential control in the application: it decides the shape of the result
 * before a single submission is read. So it behaves in two ways that a weight slider usually
 * does not.
 *
 * NOTHING IS NORMALISED SILENTLY. The running total is shown continuously and a total that is
 * not 1.0 is stated plainly rather than rescaled on save. A committee setting weights is
 * deciding relative importance; quietly rescaling their input would mean the rubric does not
 * say what they think it says.
 *
 * ZERO IS SPELLED OUT. A dimension weighted zero is not scored at all — not "scored and worth
 * little". That is a real decision with a real consequence, and it is stated next to the field
 * rather than left to be discovered from a ranking that looks wrong.
 */
export function DimensionWeights({
  weights, disabled, onSave,
}: {
  weights: Record<Dimension, number>
  disabled: boolean
  onSave: (weights: Record<Dimension, number>) => Promise<void>
}) {
  const [draft, setDraft] = useState<Record<Dimension, number>>(weights)
  const [saving, setSaving] = useState(false)

  const total = DIMENSIONS.reduce((sum, d) => sum + (draft[d] ?? 0), 0)
  const balanced = sumsToOne(total)
  const excluded = DIMENSIONS.filter((d) => (draft[d] ?? 0) === 0)

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 20,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>How much each dimension counts</h2>

      <table>
        <thead>
          <tr><th scope="col">Dimension</th><th scope="col" style={{ width: 160 }}>Weight</th></tr>
        </thead>
        <tbody>
          {DIMENSIONS.map((d) => (
            <tr key={d}>
              <td>
                {DIMENSION_LABELS[d]}
                {(draft[d] ?? 0) === 0 && (
                  <span style={{ color: 'var(--warn)' }}> — not scored at all</span>
                )}
              </td>
              <td>
                <input
                  type="number" min={0} max={1} step={0.05} disabled={disabled || saving}
                  aria-label={`Weight for ${DIMENSION_LABELS[d]}`}
                  value={draft[d] ?? 0}
                  onChange={(e) => setDraft((w) => ({ ...w, [d]: Number(e.target.value) }))}
                  style={{ width: 110, padding: '4px 6px', font: 'inherit' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p role="status" style={{ color: balanced ? 'var(--text-muted)' : 'var(--warn)' }}>
        Total {total.toFixed(2)}.{' '}
        {balanced
          ? 'These weights are what the composite will use.'
          : 'Weights must total 1.00. Nothing is rescaled for you — a rubric should say what '
            + 'the committee decided, not an adjusted version of it.'}
      </p>

      {excluded.length > 0 && (
        <p style={{ color: 'var(--warn)' }}>
          {excluded.map((d) => DIMENSION_LABELS[d]).join(', ')}{' '}
          {excluded.length === 1 ? 'is' : 'are'} weighted zero, so{' '}
          {excluded.length === 1 ? 'it' : 'they'} will not be assessed. That is different from
          being assessed and scoring badly, and the ranking will not mention it.
        </p>
      )}

      <button
        type="button" disabled={disabled || saving || !balanced}
        onClick={async () => {
          setSaving(true)
          try { await onSave(draft) } finally { setSaving(false) }
        }}
      >
        {saving ? 'Saving…' : 'Save dimension weights'}
      </button>
    </section>
  )
}
