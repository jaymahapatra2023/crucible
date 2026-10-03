import { useState } from 'react'
import { FormField, Select, TagInput, TextArea, TextInput } from './FormField.js'
import type { Standard, StandardDraft } from '../lib/catalogueApi.js'

/**
 * Authoring one organisational standard (E12).
 *
 * A standard is a switch where a principle is a journey, so this form has no anchors. What it
 * does insist on is the same evidence specification: a standard nobody can point at is a
 * statement of intent, and an evaluator asked to judge one has nothing to read.
 *
 * `appliesTo` exists so a standard can be scoped rather than made universal. A dependency-pinning
 * standard has nothing to say about a repository with no manifest, and scoping it means the
 * evaluator returns NOT_APPLICABLE rather than marking a team down for the shape of their
 * problem.
 */
const EMPTY: StandardDraft = {
  code: '', category: '', name: '', description: '', rationale: '', evidenceSpec: '',
  mandatory: true, appliesTo: [], tags: [], sourceDocument: null, owner: null,
  effectiveDate: null, reviewDate: null, sortOrder: 100,
}

export function fromStandard(s: Standard): StandardDraft {
  return {
    code: s.code, category: s.category, name: s.name, description: s.description,
    rationale: s.rationale, evidenceSpec: s.evidence_spec, mandatory: s.mandatory,
    appliesTo: s.applies_to, tags: s.tags, sourceDocument: s.source_document,
    owner: s.owner, effectiveDate: s.effective_date, reviewDate: s.review_date,
    sortOrder: s.sort_order,
  }
}

export function standardProblems(draft: StandardDraft): string[] {
  const problems: string[] = []
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(draft.code)) {
    problems.push('The code must be 3–40 characters, uppercase, starting with a letter.')
  }
  if (draft.name.trim().length < 3) problems.push('Give the standard a name.')
  // See PrincipleForm: the API takes a category from a fixed vocabulary, and an unchosen one
  // would otherwise fail server-side with a message that names no field.
  if (draft.category.trim() === '') problems.push('Choose the category this standard belongs to.')
  if (draft.description.trim().length < 10) problems.push('State what the standard requires.')
  if (draft.evidenceSpec.trim().length < 20) {
    problems.push(
      'The evidence specification needs to be specific enough to select source by. A standard '
      + 'nobody can point at cannot be assessed.')
  }
  return problems
}

export function StandardForm({
  initial, categories, busy, onSubmit, onCancel,
}: {
  initial?: StandardDraft
  categories: string[]
  busy: boolean
  onSubmit: (draft: StandardDraft) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<StandardDraft>(initial ?? EMPTY)
  const [touched, setTouched] = useState(false)
  const set = <K extends keyof StandardDraft>(k: K, v: StandardDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))
  const problems = standardProblems(draft)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (problems.length === 0) onSubmit(draft)
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <FormField id="s-code" label="Code" required hint="Short and stable, e.g. DEPS_PINNED.">
          <TextInput id="s-code" value={draft.code} required
            onChange={(e) => set('code', e.target.value.toUpperCase())} />
        </FormField>
        <FormField id="s-category" label="Category" required>
          <Select id="s-category" value={draft.category} options={['', ...categories]}
            onChange={(e) => set('category', e.target.value)} />
        </FormField>
      </div>

      <FormField id="s-name" label="Name" required>
        <TextInput id="s-name" value={draft.name} required
          onChange={(e) => set('name', e.target.value)} />
      </FormField>

      <FormField id="s-desc" label="What the standard requires" required>
        <TextArea id="s-desc" value={draft.description}
          onChange={(e) => set('description', e.target.value)} />
      </FormField>

      <FormField id="s-rationale" label="Rationale"
        hint="Why the organisation requires it. A team reading a non-compliant verdict reads this too.">
        <TextArea id="s-rationale" value={draft.rationale}
          onChange={(e) => set('rationale', e.target.value)} />
      </FormField>

      <FormField id="s-evidence" label="What a reader should be able to point at" required
        hint="This selects the source the assessment is made from.">
        <TextArea id="s-evidence" value={draft.evidenceSpec}
          onChange={(e) => set('evidenceSpec', e.target.value)} />
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <FormField id="s-applies" label="Applies to"
          hint="Leave empty for every submission. Scoping it means a submission it cannot apply to is marked not applicable, rather than non-compliant.">
          <TagInput id="s-applies" value={draft.appliesTo}
            onChange={(v) => set('appliesTo', v)} placeholder="node, python, container" />
        </FormField>
        <FormField id="s-source" label="Source document"
          hint="Where this standard is written down.">
          <TextInput id="s-source" value={draft.sourceDocument ?? ''}
            onChange={(e) => set('sourceDocument', e.target.value || null)} />
        </FormField>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <FormField id="s-effective" label="Effective from">
          <TextInput id="s-effective" type="date" value={draft.effectiveDate ?? ''}
            onChange={(e) => set('effectiveDate', e.target.value || null)} />
        </FormField>
        <FormField id="s-review" label="Review by">
          <TextInput id="s-review" type="date" value={draft.reviewDate ?? ''}
            onChange={(e) => set('reviewDate', e.target.value || null)} />
        </FormField>
        <FormField id="s-owner" label="Owner">
          <TextInput id="s-owner" value={draft.owner ?? ''}
            onChange={(e) => set('owner', e.target.value || null)} />
        </FormField>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 16 }}>
        <FormField id="s-tags" label="Tags">
          <TagInput id="s-tags" value={draft.tags} onChange={(v) => set('tags', v)} />
        </FormField>
        <FormField id="s-sort" label="Order">
          <TextInput id="s-sort" type="number" value={draft.sortOrder}
            onChange={(e) => set('sortOrder', Number(e.target.value))} />
        </FormField>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <input type="checkbox" checked={draft.mandatory}
            onChange={(e) => set('mandatory', e.target.checked)} />
          Mandatory
        </label>
        <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>
          Advisory standards are still assessed and still reported; they simply do not carry the
          same weight in a decision.
        </p>
      </div>

      {touched && problems.length > 0 && (
        <div role="alert" style={{
          border: '1px solid var(--danger)', borderRadius: 8, padding: 12, marginBottom: 12,
          background: '#fdf0ee',
        }}>
          <strong style={{ color: 'var(--danger)' }}>This standard is not ready to save</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      <p style={{ color: 'var(--text-muted)' }}>
        Saving adds this to the catalogue. It is not assessed against until it is adopted.
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save standard'}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}
