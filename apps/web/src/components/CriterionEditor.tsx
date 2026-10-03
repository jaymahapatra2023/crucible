import { useState } from 'react'
import { FormField, TextArea, TextInput } from './FormField.js'
import type { Criterion, CriterionEdit } from '../lib/rubricApi.js'

const ANCHOR_HINTS = [
  'Level 0 — what it looks like when this is absent.',
  'Level 1 — the first sign of it.',
  'Level 2 — present, but partial or unproven.',
  'Level 3 — works on the main path.',
  'Level 4 — works, and is validated or tested.',
]

/**
 * Rewriting a criterion the gate flagged (E18-S01).
 *
 * The quality gate marks a criterion `NEEDS_REWRITE` rather than dropping it — deliberately,
 * because silently discarding one would reshape the rubric the committee thinks it is reviewing.
 * And then there was no way to rewrite it. This is that way.
 *
 * The two checks are the same ones the principles form applies, for the same reasons: an
 * evidence specification too vague to select source by leaves an assessment nothing to read,
 * and anchors that do not differ give a model no way to choose between levels, so it picks the
 * middle one and the scale quietly stops meaning anything.
 */
export function criterionProblems(edit: CriterionEdit): string[] {
  const problems: string[] = []
  if (edit.name.trim().length < 3) problems.push('Give the criterion a name.')
  if (edit.description.trim().length < 10) problems.push('Describe what it asks for.')
  if (edit.evidenceSpec.trim().length < 20) {
    problems.push(
      'The evidence specification needs to be specific enough to select source by. Without it '
      + 'there is nothing for a score to read.')
  }

  const anchors = ['0', '1', '2', '3', '4'] as const
  const filled = anchors.map((k) => edit.anchors[k].trim()).filter((a) => a.length > 0)
  if (filled.length < 5) problems.push('All five anchors are needed.')
  else if (new Set(filled.map((a) => a.toLowerCase())).size < 5) {
    problems.push(
      'Two anchors say the same thing. A model given identical anchors has no way to choose '
      + 'between those levels, so every submission lands in the middle.')
  }
  return problems
}

export function toEdit(criterion: Criterion): CriterionEdit {
  return {
    name: criterion.name,
    description: criterion.description,
    evidenceSpec: criterion.evidenceSpec,
    anchors: { ...criterion.anchors },
    sourceRef: criterion.sourceRef ?? null,
  }
}

export function CriterionEditor({
  criterion, busy, onSave, onCancel, onRemove,
}: {
  criterion: Criterion
  busy: boolean
  onSave: (edit: CriterionEdit) => void
  onCancel: () => void
  onRemove: () => void
}) {
  const [edit, setEdit] = useState<CriterionEdit>(() => toEdit(criterion))
  const [touched, setTouched] = useState(false)
  const problems = criterionProblems(edit)
  const id = criterion.criterionId

  return (
    <form
      style={{
        border: '1px solid var(--accent)', borderRadius: 8, padding: 14, marginBottom: 12,
        background: 'var(--surface)',
      }}
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (problems.length === 0) onSave(edit)
      }}
    >
      <FormField id={`c-${id}-name`} label="Name" required>
        <TextInput id={`c-${id}-name`} value={edit.name}
          onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
      </FormField>

      <FormField id={`c-${id}-desc`} label="What it asks for" required>
        <TextArea id={`c-${id}-desc`} value={edit.description}
          onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
      </FormField>

      <FormField
        id={`c-${id}-ev`} label="What a reader should be able to point at" required
        hint="This selects the source a score is made from. Name the files, patterns and constructs a reader would look for."
      >
        <TextArea id={`c-${id}-ev`} value={edit.evidenceSpec}
          onChange={(e) => setEdit({ ...edit, evidenceSpec: e.target.value })} />
      </FormField>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <legend style={{ fontWeight: 600, padding: '0 6px' }}>Score anchors</legend>
        {(['0', '1', '2', '3', '4'] as const).map((level, i) => (
          <FormField key={level} id={`c-${id}-a${level}`} label={`Level ${level}`} required
            hint={ANCHOR_HINTS[i]}>
            <TextArea id={`c-${id}-a${level}`} value={edit.anchors[level]} style={{ minHeight: 52 }}
              onChange={(e) => setEdit({
                ...edit, anchors: { ...edit.anchors, [level]: e.target.value },
              })} />
          </FormField>
        ))}
      </fieldset>

      <div style={{ marginTop: 14 }}>
        <FormField id={`c-${id}-ref`} label="From the brief"
          hint="Where in the brief this comes from. Mandatory for challenge fidelity.">
          <TextInput id={`c-${id}-ref`} value={edit.sourceRef ?? ''}
            onChange={(e) => setEdit({ ...edit, sourceRef: e.target.value || null })} />
        </FormField>
      </div>

      {touched && problems.length > 0 && (
        <div role="alert" style={{
          border: '1px solid var(--danger)', borderRadius: 8, padding: 12, marginBottom: 12,
          background: '#fdf0ee',
        }}>
          <strong style={{ color: 'var(--danger)' }}>Not ready to save</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      {criterion.needsRewrite === true && (
        <p style={{ color: 'var(--text-muted)' }}>
          Saving clears the gate's flag, because it described the old wording. It does not re-run
          the gate — that is your call, and it costs a model call.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy}>Save criterion</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button" disabled={busy} style={{ marginLeft: 'auto' }}
          onClick={() => {
            if (globalThis.confirm(
              `Remove "${criterion.name}"? The rubric's remaining weights will no longer total `
              + `1.00 until you adjust them.`)) onRemove()
          }}
        >
          Remove
        </button>
      </div>
    </form>
  )
}
