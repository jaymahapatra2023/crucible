import { PrincipleForm } from './PrincipleForm.js'
import { StandardForm } from './StandardForm.js'
import type { PrincipleDraft, StandardDraft, Vocabularies } from '../lib/catalogueApi.js'

export type Editing =
  | { kind: 'none' }
  | { kind: 'principle'; id: number | null; draft?: PrincipleDraft }
  | { kind: 'standard'; id: number | null; draft?: StandardDraft }

/**
 * The authoring panel, whichever kind is being written (E12).
 *
 * Split out of the page so the page stays about the catalogue and this stays about one form.
 * Both forms share the same contract — an optional draft, a vocabulary, a submit and a cancel —
 * so the page never has to know which is open.
 */
export function CatalogueEditor({
  editing, vocab, busy, onCancel, onSavePrinciple, onSaveStandard,
}: {
  editing: Editing
  vocab: Vocabularies
  busy: boolean
  onCancel: () => void
  onSavePrinciple: (draft: PrincipleDraft, id: number | null) => void
  onSaveStandard: (draft: StandardDraft, id: number | null) => void
}) {
  if (editing.kind === 'none') return null

  const isNew = editing.id === null
  const title = editing.kind === 'principle'
    ? (isNew ? 'New principle' : 'Edit principle')
    : (isNew ? 'New standard' : 'Edit standard')

  return (
    <div style={{
      border: '1px solid var(--accent)', borderRadius: 8, padding: 16, margin: '14px 0',
    }}>
      <h2 style={{ fontSize: 15, marginTop: 0 }}>{title}</h2>
      {editing.kind === 'principle' ? (
        <PrincipleForm
          {...(editing.draft ? { initial: editing.draft } : {})}
          pillars={vocab.pillars} busy={busy} onCancel={onCancel}
          onSubmit={(draft) => onSavePrinciple(draft, editing.id)}
        />
      ) : (
        <StandardForm
          {...(editing.draft ? { initial: editing.draft } : {})}
          categories={vocab.standardCategories} busy={busy} onCancel={onCancel}
          onSubmit={(draft) => onSaveStandard(draft, editing.id)}
        />
      )}
    </div>
  )
}

/**
 * What adoption currently means for this list.
 *
 * "Nothing adopted" is a state with real consequences, not an empty list: E07 excludes an
 * unscoreable dimension from every composite rather than scoring each team zero for it. A
 * reviewer who does not know that will read the missing dimension as a failure by the teams.
 */
export function AdoptionSummary({ adopted, total }: { adopted: number; total: number }) {
  return (
    <p style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px',
      color: adopted === 0 ? 'var(--warn)' : 'var(--text-muted)',
    }}>
      {adopted === 0
        ? 'Nothing in this list is adopted, so this dimension is not scored at all. Submissions '
          + 'are not marked down for it — the dimension is excluded from every composite. Adopt '
          + 'at least one to have it assessed.'
        : `${adopted} of ${total} adopted. Only adopted entries are assessed against.`}
    </p>
  )
}
