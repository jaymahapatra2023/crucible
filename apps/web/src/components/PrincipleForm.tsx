import { useState } from 'react'
import { FormField, Select, TagInput, TextArea, TextInput } from './FormField.js'
import type { Principle, PrincipleDraft } from '../lib/catalogueApi.js'

/**
 * Authoring one architectural principle (E12).
 *
 * Two things this form insists on, because both are what makes a principle assessable rather
 * than decorative:
 *
 *  - An EVIDENCE SPECIFICATION. Without it the evaluator has nothing to select source by, and
 *    the assessment degrades into a second-order reading of a summary.
 *  - FIVE DISTINCT ANCHORS. Identical anchors give the model no way to choose between levels,
 *    so it picks the middle one and the maturity scale stops meaning anything.
 *
 * Both are validated server-side too. They are checked here as well so an author finds out
 * while they are still writing, not after they submit.
 */
const ANCHOR_HINTS = [
  'Level 0 — what it looks like when this has not been started.',
  'Level 1 — the first real step, however small.',
  'Level 2 — partly adopted: some of the codebase, not all of it.',
  'Level 3 — adopted as the norm, with the exceptions being exceptions.',
  'Level 4 — adopted and enforced, so a regression would be caught.',
]

const EMPTY: PrincipleDraft = {
  code: '', pillar: '', name: '', description: '', rationale: '', guidance: '',
  evidenceSpec: '', anchors: ['', '', '', '', ''],
  sourceRefs: [], tags: [], owner: null, sortOrder: 100,
}

export function fromPrinciple(p: Principle): PrincipleDraft {
  return {
    code: p.code, pillar: p.pillar, name: p.name, description: p.description,
    rationale: p.rationale, guidance: p.guidance, evidenceSpec: p.evidence_spec,
    anchors: [p.anchor_0, p.anchor_1, p.anchor_2, p.anchor_3, p.anchor_4],
    sourceRefs: p.source_refs, tags: p.tags, owner: p.owner, sortOrder: p.sort_order,
  }
}

/** Problems an author should see before they submit. Empty means the draft is submittable. */
export function principleProblems(draft: PrincipleDraft): string[] {
  const problems: string[] = []
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(draft.code)) {
    problems.push('The code must be 3–40 characters, uppercase, starting with a letter.')
  }
  if (draft.name.trim().length < 3) problems.push('Give the principle a name.')
  // The API takes a pillar from a fixed vocabulary. Without this the form submits an empty
  // string and the author gets "the request body did not match the expected shape", which
  // tells them nothing about which field to fix.
  if (draft.pillar.trim() === '') problems.push('Choose the pillar this principle belongs to.')
  if (draft.description.trim().length < 10) problems.push('Describe what the principle asks for.')
  if (draft.evidenceSpec.trim().length < 20) {
    problems.push(
      'The evidence specification needs to be specific enough to select source by. Without it '
      + 'there is nothing for an assessment to read.')
  }
  const filled = draft.anchors.map((a) => a.trim()).filter((a) => a.length > 0)
  if (filled.length < 5) problems.push('All five maturity anchors are needed.')
  else if (new Set(filled.map((a) => a.toLowerCase())).size < 5) {
    problems.push(
      'Two anchors say the same thing. Identical anchors give an assessment no way to choose '
      + 'between levels, so every submission lands in the middle.')
  }
  return problems
}

export function PrincipleForm({
  initial, pillars, busy, onSubmit, onCancel,
}: {
  initial?: PrincipleDraft
  pillars: string[]
  busy: boolean
  onSubmit: (draft: PrincipleDraft) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<PrincipleDraft>(initial ?? EMPTY)
  const [touched, setTouched] = useState(false)
  const set = <K extends keyof PrincipleDraft>(k: K, v: PrincipleDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))
  const problems = principleProblems(draft)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (problems.length === 0) onSubmit(draft)
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <FormField id="p-code" label="Code" required hint="Short and stable, e.g. LAYERED_DESIGN.">
          <TextInput id="p-code" value={draft.code} required
            onChange={(e) => set('code', e.target.value.toUpperCase())} />
        </FormField>
        <FormField id="p-pillar" label="Pillar" required hint="Which part of the architecture this belongs to.">
          <Select id="p-pillar" value={draft.pillar} options={['', ...pillars]}
            onChange={(e) => set('pillar', e.target.value)} />
        </FormField>
      </div>

      <FormField id="p-name" label="Name" required>
        <TextInput id="p-name" value={draft.name} required
          onChange={(e) => set('name', e.target.value)} />
      </FormField>

      <FormField id="p-desc" label="Description" required
        hint="What the principle asks a team to do.">
        <TextArea id="p-desc" value={draft.description}
          onChange={(e) => set('description', e.target.value)} />
      </FormField>

      <FormField id="p-rationale" label="Rationale"
        hint="Why the organisation holds this. Teams read it; so does anyone appealing a score.">
        <TextArea id="p-rationale" value={draft.rationale}
          onChange={(e) => set('rationale', e.target.value)} />
      </FormField>

      <FormField id="p-evidence" label="What a reader should be able to point at" required
        hint="This selects the source an assessment is made from. Name the files, patterns and constructs that would show the principle in use.">
        <TextArea id="p-evidence" value={draft.evidenceSpec}
          onChange={(e) => set('evidenceSpec', e.target.value)} />
      </FormField>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <legend style={{ fontWeight: 600, padding: '0 6px' }}>Maturity anchors</legend>
        {draft.anchors.map((anchor, i) => (
          <FormField key={i} id={`p-anchor-${i}`} label={`Level ${i}`} required hint={ANCHOR_HINTS[i]}>
            <TextArea id={`p-anchor-${i}`} value={anchor} style={{ minHeight: 52 }}
              onChange={(e) => {
                const next = [...draft.anchors] as PrincipleDraft['anchors']
                next[i] = e.target.value
                set('anchors', next)
              }} />
          </FormField>
        ))}
      </fieldset>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 16, marginTop: 14 }}>
        <FormField id="p-tags" label="Tags">
          <TagInput id="p-tags" value={draft.tags} onChange={(v) => set('tags', v)} />
        </FormField>
        <FormField id="p-owner" label="Owner" hint="Who to ask about this.">
          <TextInput id="p-owner" value={draft.owner ?? ''}
            onChange={(e) => set('owner', e.target.value || null)} />
        </FormField>
        <FormField id="p-sort" label="Order">
          <TextInput id="p-sort" type="number" value={draft.sortOrder}
            onChange={(e) => set('sortOrder', Number(e.target.value))} />
        </FormField>
      </div>

      {touched && problems.length > 0 && (
        <div role="alert" style={{
          border: '1px solid var(--danger)', borderRadius: 8, padding: 12, marginBottom: 12,
          background: '#fdf0ee',
        }}>
          <strong style={{ color: 'var(--danger)' }}>This principle is not ready to save</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      <p style={{ color: 'var(--text-muted)' }}>
        Saving adds this to the catalogue. It is not assessed against until it is adopted.
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save principle'}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}
