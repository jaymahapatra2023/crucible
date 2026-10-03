import { useState } from 'react'
import { FormField, TextArea, TextInput } from './FormField.js'
import type { CalibrationReport, GateCriteria } from '../lib/calibrationApi.js'

/**
 * Running the gate (E18-S04).
 *
 * The ordering is the whole point and the UI enforces it: criteria are captured BEFORE the
 * report can be produced. Criteria written afterwards describe whatever the report happened to
 * say, which is not a gate — it is a rationalisation with a threshold attached.
 */
export function GateCriteriaForm({
  existing, busy, onRecord,
}: {
  existing: GateCriteria | null
  busy: boolean
  onRecord: (criteria: {
    minRankCorrelation: number; maxMaterialDisagreements: number
    materialRankGap: number; maxRunVariance: number
    fallbackPlan: string; notes: string
  }) => void
}) {
  const [minCorrelation, setMinCorrelation] = useState('0.7')
  const [maxDisagreements, setMaxDisagreements] = useState('2')
  const [gap, setGap] = useState('3')
  const [maxVariance, setMaxVariance] = useState('10')
  const [fallback, setFallback] = useState(
    'Fully human judging. The system may be used to gather evidence for people to judge from, '
    + 'and must not be used to rank or eliminate.')
  const [notes, setNotes] = useState('')

  if (existing) {
    return (
      <section data-testid="criteria-recorded" style={box}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Gate criteria — recorded</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Written by {existing.recorded_by} before any report existed, which is what makes them a
          gate rather than a description of the result.
        </p>
        <ul style={{ paddingLeft: 18 }}>
          <li>Rank correlation must be at least {existing.min_rank_correlation}</li>
          <li>At most {existing.max_material_disagreements} material disagreements</li>
          <li>A disagreement is material at {existing.material_rank_gap} places or more</li>
          <li>Run-to-run variance at most {existing.max_run_variance}</li>
        </ul>
        <p><strong>If the gate fails:</strong> {existing.fallback_plan}</p>
      </section>
    )
  }

  const fallbackReady = fallback.trim().length >= 20

  return (
    <form
      style={box}
      onSubmit={(e) => {
        e.preventDefault()
        if (!fallbackReady) return
        onRecord({
          minRankCorrelation: Number(minCorrelation),
          maxMaterialDisagreements: Number(maxDisagreements),
          materialRankGap: Number(gap),
          maxRunVariance: Number(maxVariance),
          fallbackPlan: fallback.trim(),
          notes: notes.trim(),
        })
      }}
    >
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Gate criteria</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Decide what passing means <strong>before</strong> the report exists. No report can be
        produced until these are recorded, because criteria written afterwards describe whatever
        the report happened to say.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <FormField id="gc-corr" label="Minimum rank correlation" required
          hint="How closely the machine ordering must track the hand ordering.">
          <TextInput id="gc-corr" type="number" step="0.05" min="-1" max="1"
            value={minCorrelation} onChange={(e) => setMinCorrelation(e.target.value)} />
        </FormField>
        <FormField id="gc-dis" label="Material disagreements allowed" required>
          <TextInput id="gc-dis" type="number" min="0" max="100"
            value={maxDisagreements} onChange={(e) => setMaxDisagreements(e.target.value)} />
        </FormField>
        <FormField id="gc-gap" label="A disagreement is material at" required
          hint="Places apart. Below this, two orderings are differing about a close call.">
          <TextInput id="gc-gap" type="number" min="1" max="100"
            value={gap} onChange={(e) => setGap(e.target.value)} />
        </FormField>
        <FormField id="gc-var" label="Run-to-run variance allowed" required>
          <TextInput id="gc-var" type="number" min="0" max="100"
            value={maxVariance} onChange={(e) => setMaxVariance(e.target.value)} />
        </FormField>
      </div>

      <FormField id="gc-fb" label="If the gate fails, what happens" required
        hint="Written now, while it is hypothetical. Whoever reads this will be reading it at the worst possible moment.">
        <TextArea id="gc-fb" value={fallback} onChange={(e) => setFallback(e.target.value)} />
      </FormField>

      <FormField id="gc-notes" label="Notes">
        <TextArea id="gc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </FormField>

      <button type="submit" disabled={busy || !fallbackReady}>Record these criteria</button>
    </form>
  )
}

/** The report, and the decision taken on it. */
export function GateDecision({
  report, criteria, busy, onDecide,
}: {
  report: CalibrationReport
  criteria: GateCriteria | null
  busy: boolean
  onDecide: (decision: 'GO' | 'NO_GO', rationale: string) => void
}) {
  const [rationale, setRationale] = useState('')
  const ready = rationale.trim().length >= 20

  return (
    <section style={box} data-testid="gate-decision">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>The report</h2>
      <ul style={{ paddingLeft: 18 }}>
        <li>
          Rank correlation: <strong>{report.rank_correlation ?? 'not computable'}</strong>
          {criteria && ` (criterion: at least ${criteria.min_rank_correlation})`}
        </li>
        <li>
          Material disagreements: <strong>{report.material_disagreements}</strong>
          {criteria && ` (criterion: at most ${criteria.max_material_disagreements})`}
        </li>
        <li>Run-to-run variance: <strong>{report.run_variance ?? 'not computable'}</strong></li>
        <li>Sample size: {report.sample_size}</li>
      </ul>

      <RaterAgreementNote report={report} />

      {report.disagreements.length > 0 && (
        <>
          <h3 style={{ fontSize: 14 }}>Where the machine and the people differed</h3>
          <ul style={{ paddingLeft: 18 }}>
            {report.disagreements.map((d) => (
              <li key={d.entryId}>
                <strong>{d.label}</strong> — hand {d.handPosition}, machine {d.machinePosition}{' '}
                ({d.gap} places). {d.evidence}
              </li>
            ))}
          </ul>
        </>
      )}

      <form
        style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}
        onSubmit={(e) => { e.preventDefault(); if (ready) onDecide('GO', rationale.trim()) }}
      >
        <FormField id="gd-why" label="Why this decision" required
          hint="Mandatory either way. &quot;Why did you proceed&quot; is as much a question as &quot;why did you stop&quot;.">
          <TextArea id="gd-why" value={rationale}
            onChange={(e) => setRationale(e.target.value)} />
        </FormField>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy || !ready}>Record GO</button>
          <button type="button" disabled={busy || !ready}
            onClick={() => onDecide('NO_GO', rationale.trim())}>
            Record NO-GO
          </button>
        </div>
        {criteria && (
          <p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>
            A NO-GO invokes the recorded fallback: {criteria.fallback_plan}
          </p>
        )}
      </form>
    </section>
  )
}

const box: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 16,
  background: 'var(--surface)',
}

/**
 * What the machine's correlation is being measured against.
 *
 * The coefficient above is meaningless without this. A ρ of 0.61 against a consensus whose
 * authors agree at 0.95 is a different statement from the same 0.61 against authors who agree at
 * 0.45 — in the second case there is no stable human ordering, and the machine is being marked
 * against noise.
 *
 * Shown for every strength, not only the bad ones: a reader who sees this box only when
 * something is wrong learns to read its absence as "fine", which is the same mistake as leaving
 * the number unqualified.
 */
function RaterAgreementNote({ report }: { report: CalibrationReport }) {
  const raters = report.detail?.interRater
  if (!raters) return null

  const weak = raters.strength === 'WEAK' || raters.strength === 'NONE'

  return (
    <div
      data-testid="rater-agreement"
      style={{
        border: `1px solid ${weak ? 'var(--danger)' : 'var(--border)'}`,
        borderRadius: 8, padding: 10, margin: '10px 0',
      }}
    >
      <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>
        {/* Never colour alone (P5.4): the strength is written out. */}
        Ranker agreement: <strong>{raters.strength}</strong>
        {raters.lowest !== null && (
          <span style={{ fontWeight: 400 }}> · lowest pair ρ {raters.lowest.toFixed(3)}</span>
        )}
      </h3>
      <p style={{ margin: '0 0 6px', fontSize: 13 }}>{raters.note}</p>
      {raters.pairs.length > 0 && (
        <ul style={{ paddingLeft: 18, margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
          {/* Every pair, not an average: one outlying ranker must stay visible. */}
          {raters.pairs.map((pair) => (
            <li key={`${pair.a}|${pair.b}`}>
              {pair.a} vs {pair.b}: {pair.rho === null ? 'not computable' : pair.rho.toFixed(3)}
              {' '}over {pair.n} entries
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
