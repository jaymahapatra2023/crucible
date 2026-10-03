import { useState } from 'react'
import { FormField, TextInput } from './FormField.js'
import type { Challenge } from '../lib/challengeApi.js'

/**
 * Starting a cohort run (E39).
 *
 * `startBatch` existed in the client and was called by nothing, so the only way to score a cohort
 * was curl. On the night of an event, with forty teams waiting, that is not a workable answer.
 *
 * Three decisions, and each is deliberately explicit rather than defaulted:
 *
 *  - **The cohort key** names the field being judged together. Ranking, the cut line and
 *    run-to-run variance are all scoped to it, so getting it wrong does not fail — it quietly
 *    ranks a team against the wrong field.
 *  - **Which challenges**, because a cohort may span several or be limited to one.
 *  - **Run 1 or run 2**, because a cohort is scored exactly twice and the pair is what measures
 *    reproducibility. Run 2 is not a retry; it is the second measurement.
 */
export function StartRunPanel({
  challenges, existing, busy, failure, onStart,
}: {
  challenges: readonly Challenge[]
  /** Runs that already exist, so a collision is visible before the click. */
  existing: ReadonlyArray<{ cohortKey: string; runIndex: number }>
  busy: boolean
  failure: string | null
  onStart: (input: { cohortKey: string; challengeIds: number[]; runIndex: 1 | 2 }) => void
}) {
  const [cohortKey, setCohortKey] = useState('')
  const [runIndex, setRunIndex] = useState<1 | 2>(1)
  const [selected, setSelected] = useState<number[]>([])

  const ready = cohortKey.trim().length > 0
  /*
   * Starting a cohort and run that already exist CONTINUES that run — the orchestrator reuses it
   * on purpose, because a resumed batch must write its remaining scores into the run holding the
   * rest. Correct for a resume, and silent for a typo: mistype the cohort and the work merges
   * into somebody else's run with nothing said. Nothing refuses this, so the operator has to be
   * told before they click.
   */
  const collides = existing.some(
    (r) => r.cohortKey === cohortKey.trim() && r.runIndex === runIndex)

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 20,
    }}>
      <h2 style={{ fontSize: 15, marginTop: 0 }}>Start a run</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!ready) return
          onStart({ cohortKey: cohortKey.trim(), challengeIds: selected, runIndex })
        }}
      >
        <FormField
          id="run-cohort" label="Cohort" required
          hint="The field being judged together. Ranking, the cut line and run-to-run variance are all scoped to it — two runs of the same cohort are what measure reproducibility."
        >
          <TextInput
            id="run-cohort" value={cohortKey} placeholder="oct-2026"
            onChange={(e) => setCohortKey(e.target.value)}
          />
        </FormField>

        <FormField
          id="run-challenges" label="Challenges"
          hint="Leave all unticked to include every challenge. Only current, valid entries are scored."
        >
          <div id="run-challenges" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {challenges.length === 0 && (
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>No challenges yet.</span>
            )}
            {challenges.map((challenge) => (
              <label key={challenge.challengeId} style={{
                display: 'flex', alignItems: 'center', gap: 5, fontSize: 13,
              }}>
                <input
                  type="checkbox" disabled={busy}
                  checked={selected.includes(challenge.challengeId)}
                  onChange={(e) => setSelected((prev) => e.target.checked
                    ? [...prev, challenge.challengeId]
                    : prev.filter((id) => id !== challenge.challengeId))}
                />
                {challenge.name}
              </label>
            ))}
          </div>
        </FormField>

        <FormField
          id="run-index" label="Which run" required
          hint="A cohort is scored exactly twice. Run 2 is the second measurement, not a retry — the difference between them is the reproducibility check."
        >
          <select
            id="run-index" value={runIndex} disabled={busy}
            onChange={(e) => setRunIndex(Number(e.target.value) === 2 ? 2 : 1)}
            style={{
              font: 'inherit', padding: '6px 8px', border: '1px solid var(--border)',
              borderRadius: 6, background: 'var(--surface)', color: 'var(--text)',
            }}
          >
            <option value={1}>Run 1</option>
            <option value={2}>Run 2</option>
          </select>
        </FormField>

        {collides && (
          <p role="status" data-testid="run-collision" style={{
            border: '1px solid var(--warn)', borderRadius: 6, padding: 8,
            fontSize: 13, margin: '0 0 8px',
          }}>
            <strong>{cohortKey.trim()}</strong> already has run {runIndex}. Starting will{' '}
            <strong>continue that run</strong> rather than create a new one — which is what you
            want for a resume, and not what you want if you meant a different cohort.
          </p>
        )}

        {failure !== null && (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>{failure}</p>
        )}

        <button type="submit" disabled={busy || !ready}>
          {collides ? `Continue run ${runIndex}` : `Start run ${runIndex}`}
        </button>

        {/* Said before the click, not discovered after it: this spends money and takes hours. */}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0' }}>
          This scans, probes and scores every current valid entry in scope. It costs model calls
          and takes hours at cohort scale — progress is shown as soon as it starts.
        </p>
      </form>
    </section>
  )
}
