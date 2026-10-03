import { useState } from 'react'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { CatalogueRow } from '../components/CatalogueRow.js'
import { AdoptionSummary, CatalogueEditor, type Editing } from '../components/CatalogueEditor.js'
import { fromPrinciple } from '../components/PrincipleForm.js'
import { fromStandard } from '../components/StandardForm.js'
import {
  createPrinciple, createStandard, getCatalogue, getVocabularies,
  retirePrinciple, retireStandard, setPrincipleAdopted, setStandardAdopted,
  updatePrinciple, updateStandard,
  type Catalogue, type Vocabularies,
} from '../lib/catalogueApi.js'

type Tab = 'principles' | 'standards'

/**
 * The principles and standards an evaluation judges against (E12).
 *
 * Two ideas govern this page and both are visible in it.
 *
 * AUTHORING IS NOT ADOPTION. Writing a principle down adds it to the catalogue; it is assessed
 * against only once someone adopts it. Collapsing the two would mean a half-drafted principle
 * silently changed what every team was being scored on.
 *
 * RETIRE, DO NOT DELETE. A principle that has already been assessed against is withdrawn rather
 * than removed, because deleting it would leave every score taken under it unexplainable.
 */
export function CataloguePage() {
  const [tab, setTab] = useState<Tab>('principles')
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const { state, reload } = useAsyncData<{ catalogue: Catalogue; vocab: Vocabularies }>(
    async () => {
      const [catalogue, vocab] = await Promise.all([getCatalogue(), getVocabularies()])
      return { catalogue, vocab }
    },
    [],
  )

  async function act(what: () => Promise<string>) {
    setBusy(true)
    setFailure(null)
    try {
      setNotice(await what())
      setEditing({ kind: 'none' })
      reload()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading the catalogue" />
  if (state.status === 'error') {
    return (
      <ErrorState title="The catalogue could not be loaded" message={state.error.message}
        detail={state.error.code} onRetry={reload} />
    )
  }

  const { catalogue, vocab } = state.data
  const showingPrinciples = tab === 'principles'
  const total = showingPrinciples ? catalogue.principles.length : catalogue.standards.length
  const adopted = showingPrinciples ? catalogue.adoptedPrinciples : catalogue.adoptedStandards

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Principles and standards</h1>
        <span style={{ color: 'var(--text-muted)' }}>
          What every submission is assessed against, alongside the challenge rubric.
        </span>
      </header>

      <div role="tablist" aria-label="Catalogue" style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {(['principles', 'standards'] as const).map((t) => (
          <button
            key={t} role="tab" type="button" aria-selected={tab === t}
            onClick={() => { setTab(t); setEditing({ kind: 'none' }) }}
            style={{
              padding: '6px 12px', borderRadius: 6, textTransform: 'capitalize',
              border: '1px solid var(--border)',
              background: tab === t ? 'var(--surface)' : 'transparent',
              fontWeight: tab === t ? 600 : 400,
            }}
          >
            {t} ({t === 'principles' ? catalogue.principles.length : catalogue.standards.length})
          </button>
        ))}
        <button type="button" style={{ marginLeft: 'auto' }} disabled={busy}
          onClick={() => setEditing(
            showingPrinciples ? { kind: 'principle', id: null } : { kind: 'standard', id: null })}>
          Add {showingPrinciples ? 'a principle' : 'a standard'}
        </button>
      </div>

      {notice && <p role="status" style={{ color: 'var(--ok)' }}>{notice}</p>}
      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      <AdoptionSummary adopted={adopted} total={total} />

      <CatalogueEditor
        editing={editing} vocab={vocab} busy={busy}
        onCancel={() => setEditing({ kind: 'none' })}
        onSavePrinciple={(draft, id) => act(async () => {
          if (id === null) {
            await createPrinciple(draft)
            return `${draft.code} was added. It is not assessed against until you adopt it.`
          }
          await updatePrinciple(id, draft)
          return `${draft.code} was updated.`
        })}
        onSaveStandard={(draft, id) => act(async () => {
          if (id === null) {
            await createStandard(draft)
            return `${draft.code} was added. It is not assessed against until you adopt it.`
          }
          await updateStandard(id, draft)
          return `${draft.code} was updated.`
        })}
      />

      {total === 0 && (
        <EmptyState
          title={`No ${tab} yet`}
          explanation={
            'Nothing has been written down. Until something is adopted here, this dimension is '
            + 'excluded from scoring rather than scored as zero.'}
        />
      )}

      {showingPrinciples && catalogue.principles.map((p) => (
        <CatalogueRow
          key={p.principle_id} code={p.code} name={p.name} group={p.pillar}
          description={p.description} adopted={p.active} busy={busy}
          onToggleAdopted={() => act(async () => {
            await setPrincipleAdopted(p.principle_id, !p.active)
            return `${p.code} is now ${p.active ? 'not adopted' : 'adopted'}.`
          })}
          onEdit={() => setEditing({ kind: 'principle', id: p.principle_id, draft: fromPrinciple(p) })}
          onRetire={() => act(async () => (await retirePrinciple(p.principle_id)).reason)}
        />
      ))}

      {!showingPrinciples && catalogue.standards.map((s) => (
        <CatalogueRow
          key={s.standard_id} code={s.code} name={s.name} group={s.category}
          description={s.description} adopted={s.active} mandatory={s.mandatory} busy={busy}
          onToggleAdopted={() => act(async () => {
            await setStandardAdopted(s.standard_id, !s.active)
            return `${s.code} is now ${s.active ? 'not adopted' : 'adopted'}.`
          })}
          onEdit={() => setEditing({ kind: 'standard', id: s.standard_id, draft: fromStandard(s) })}
          onRetire={() => act(async () => (await retireStandard(s.standard_id)).reason)}
        />
      ))}
    </section>
  )
}
