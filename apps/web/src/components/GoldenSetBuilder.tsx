import { useState } from 'react'
import { FormField, Select, TextArea, TextInput } from './FormField.js'
import {
  EDGE_CASES, EXPECTED_BANDS, type GoldenSetDetail,
} from '../lib/calibrationApi.js'

/**
 * Assembling the golden set (E18-S02).
 *
 * The set is the evidence the gate rests on, so a thin one has to be visible BEFORE it is used,
 * not discovered afterwards. E11-S01 asks for at least eight repositories spanning clearly
 * strong, middling and clearly weak, plus four edge cases — and those edge cases are the inputs
 * most likely to be scored wrongly, so a set without them tests the easy half.
 *
 * The checklist is rendered from the server's own readiness answer rather than recomputed here.
 * Two implementations of "is this set good enough" would disagree, and the one that matters is
 * the one that blocks sealing.
 */
export function GoldenSetBuilder({
  detail, busy, onAdd, onSeal,
}: {
  detail: GoldenSetDetail
  busy: boolean
  onAdd: (entry: {
    label: string; repoUrl: string
    expectedBand: (typeof EXPECTED_BANDS)[number]
    edgeCase: (typeof EDGE_CASES)[number] | null
    notes: string
  }) => void
  onSeal: () => void
}) {
  const [label, setLabel] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [band, setBand] = useState<(typeof EXPECTED_BANDS)[number]>('MIDDLING')
  const [edgeCase, setEdgeCase] = useState<string>('')
  const [notes, setNotes] = useState('')

  const sealed = detail.set.status === 'SEALED'
  const ready = label.trim().length >= 2 && /^https?:\/\//.test(repoUrl.trim())

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>
        {detail.set.name}
        <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>
          {sealed ? 'sealed' : 'open'} · {detail.entries.length} repositories
        </span>
      </h2>

      <ReadinessChecklist detail={detail} />

      {!sealed && (
        <form
          style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}
          onSubmit={(e) => {
            e.preventDefault()
            if (!ready) return
            onAdd({
              label: label.trim(),
              repoUrl: repoUrl.trim(),
              expectedBand: band,
              edgeCase: edgeCase === '' ? null : edgeCase as (typeof EDGE_CASES)[number],
              notes: notes.trim(),
            })
            setLabel(''); setRepoUrl(''); setNotes(''); setEdgeCase('')
          }}
        >
          <h3 style={{ fontSize: 14, marginTop: 0 }}>Add a repository</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <FormField id="gs-label" label="Label" required>
              <TextInput id="gs-label" value={label}
                onChange={(e) => setLabel(e.target.value)} />
            </FormField>
            <FormField id="gs-url" label="Repository URL" required>
              <TextInput id="gs-url" value={repoUrl} placeholder="https://github.com/…"
                onChange={(e) => setRepoUrl(e.target.value)} />
            </FormField>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <FormField id="gs-band" label="Where you expect it to land" required
              hint="Your judgement, recorded before any machine sees it.">
              <Select id="gs-band" value={band} options={EXPECTED_BANDS}
                onChange={(e) => setBand(e.target.value as (typeof EXPECTED_BANDS)[number])} />
            </FormField>
            <FormField id="gs-edge" label="Edge case"
              hint="The inputs most likely to be scored wrongly. A set without them tests the easy half.">
              <Select id="gs-edge" value={edgeCase} options={['', ...EDGE_CASES]}
                onChange={(e) => setEdgeCase(e.target.value)} />
            </FormField>
          </div>

          <FormField id="gs-notes" label="Why this one"
            hint="What it is meant to exercise. Read by whoever reviews the gate decision.">
            <TextArea id="gs-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || !ready}>Add to the set</button>
            <button
              type="button" disabled={busy || !detail.readiness.canSeal}
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                if (globalThis.confirm(
                  'Sealing stops any further repository being added. The gate decision will '
                  + 'rest on exactly this set. Seal it?')) onSeal()
              }}
            >
              Seal the set
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

/** What E11-S01 asks for, checked against what the set actually holds. */
function ReadinessChecklist({ detail }: { detail: GoldenSetDetail }) {
  const { readiness } = detail

  return (
    <div data-testid="set-readiness">
      {readiness.canSeal ? (
        <p style={{ color: 'var(--ok)' }}>
          This set spans what a calibration needs: {readiness.entries} repositories,{' '}
          {/* NOT "independent rankings". Nothing here can establish that two people did not
              confer, and the word was asserting something never checked. What can be shown is
              how far apart they landed, which is the warning below. */}
          {readiness.rankers.length} hand rankings, every band and every edge case.
        </p>
      ) : (
        <>
          <p style={{ color: 'var(--warn)', marginBottom: 6 }}>
            <strong>Not yet ready to seal.</strong> A gate decision rests on this set, so it has
            to span the range before it is used rather than after.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {readiness.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </>
      )}

      {/* Shown in BOTH branches. A set that can be sealed but whose rankers barely agree — or
          agree implausibly closely — is the dangerous case, precisely because nothing stops it.
          Sealing is irreversible, so this is the last moment it can be acted on. */}
      {readiness.warnings.length > 0 && (
        <div data-testid="seal-warnings" style={{
          border: '1px solid var(--warn)', borderRadius: 8, padding: 10, marginTop: 10,
        }}>
          <strong style={{ fontSize: 13 }}>Before you seal</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {readiness.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
