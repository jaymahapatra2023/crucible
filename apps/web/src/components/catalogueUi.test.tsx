/**
 * Authoring principles and standards in the application (E12).
 *
 * The rules under test are the two that decide whether a catalogue entry is assessable rather
 * than decorative: an evidence specification specific enough to select source by, and five
 * anchors that actually differ. Both are also enforced server-side; they are checked here so an
 * author learns while they are still writing.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PrincipleForm, principleProblems, fromPrinciple } from './PrincipleForm.js'
import { StandardForm, standardProblems, fromStandard } from './StandardForm.js'
import { CatalogueRow } from './CatalogueRow.js'
import type { Principle, PrincipleDraft, Standard, StandardDraft } from '../lib/catalogueApi.js'

const draft = (over: Partial<PrincipleDraft> = {}): PrincipleDraft => ({
  code: 'LAYERED', pillar: 'Design', name: 'Layered design',
  description: 'Separate concerns into layers with explicit boundaries.',
  rationale: '', guidance: '',
  evidenceSpec: 'Module boundaries, imports that cross them, and dependency direction.',
  anchors: ['none', 'one boundary', 'some boundaries', 'the norm', 'enforced in CI'],
  sourceRefs: [], tags: [], owner: null, sortOrder: 100, ...over,
})

describe('what makes a principle assessable', () => {
  it('accepts a complete draft', () => {
    expect(principleProblems(draft())).toEqual([])
  })

  it('rejects an evidence specification too vague to select source by', () => {
    // Without one, an assessment has nothing to read and degrades into a second-order pass
    // over a summary — the exact defect the evidence-driven context builder exists to fix.
    expect(principleProblems(draft({ evidenceSpec: 'good code' })).join(' '))
      .toMatch(/specific enough to select source by/i)
  })

  it('rejects two anchors that say the same thing', () => {
    // Identical anchors give a model no way to choose between levels, so it picks the middle
    // one and the maturity scale silently stops meaning anything.
    const problems = principleProblems(draft({
      anchors: ['none', 'partial', 'partial', 'the norm', 'enforced'],
    }))
    expect(problems.join(' ')).toMatch(/say the same thing/i)
  })

  it('ignores case when deciding whether two anchors are the same', () => {
    expect(principleProblems(draft({
      anchors: ['None', 'none', 'some', 'the norm', 'enforced'],
    })).join(' ')).toMatch(/say the same thing/i)
  })

  it('requires all five anchors', () => {
    expect(principleProblems(draft({ anchors: ['a', 'b', 'c', 'd', ''] })).join(' '))
      .toMatch(/All five maturity anchors/i)
  })

  it('rejects a code that is not a stable identifier', () => {
    expect(principleProblems(draft({ code: 'my principle' })).join(' ')).toMatch(/uppercase/i)
  })
})

describe('the principle form', () => {
  it('does not submit a draft that is not ready, and says why', async () => {
    const onSubmit = vi.fn()
    render(<PrincipleForm initial={draft({ evidenceSpec: 'x' })} pillars={['Design']}
      busy={false} onSubmit={onSubmit} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /save principle/i }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/not ready to save/i)
  })

  it('submits a complete draft', async () => {
    const onSubmit = vi.fn()
    render(<PrincipleForm initial={draft()} pillars={['Design']}
      busy={false} onSubmit={onSubmit} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /save principle/i }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('shows no error before the author has tried to save (P5.4)', () => {
    render(<PrincipleForm initial={draft({ code: '' })} pillars={[]}
      busy={false} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says that saving is not adopting', () => {
    render(<PrincipleForm pillars={[]} busy={false} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/not assessed against until it is adopted/i)).toBeInTheDocument()
  })

  it('labels every anchor with what that level means', () => {
    render(<PrincipleForm pillars={[]} busy={false} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText(/Level 0/)).toBeInTheDocument()
    expect(screen.getByText(/what it looks like when this has not been started/i))
      .toBeInTheDocument()
  })

  it('round-trips a saved principle back into an editable draft', () => {
    const saved = {
      principle_id: 1, code: 'LAYERED', pillar: 'Design', name: 'Layered design',
      description: 'd', rationale: 'r', guidance: 'g', evidence_spec: 'e',
      anchor_0: 'a0', anchor_1: 'a1', anchor_2: 'a2', anchor_3: 'a3', anchor_4: 'a4',
      source_refs: [], tags: ['x'], owner: 'o', active: true, sort_order: 5,
    } satisfies Principle
    expect(fromPrinciple(saved).anchors).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
    expect(fromPrinciple(saved).evidenceSpec).toBe('e')
  })
})

const stdDraft = (over: Partial<StandardDraft> = {}): StandardDraft => ({
  code: 'DEPS_PINNED', category: 'Supply chain', name: 'Dependencies are pinned',
  description: 'Every dependency resolves to an exact version.',
  rationale: '', evidenceSpec: 'Lockfiles, version ranges in manifests, and CI install steps.',
  mandatory: true, appliesTo: [], tags: [], sourceDocument: null, owner: null,
  effectiveDate: null, reviewDate: null, sortOrder: 100, ...over,
})

describe('what makes a standard assessable', () => {
  it('accepts a complete draft', () => {
    expect(standardProblems(stdDraft())).toEqual([])
  })

  it('rejects an evidence specification too vague to point at', () => {
    expect(standardProblems(stdDraft({ evidenceSpec: 'secure' })).join(' '))
      .toMatch(/cannot be assessed/i)
  })

  it('explains that scoping a standard prevents a wrong non-compliant verdict', () => {
    render(<StandardForm categories={[]} busy={false} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/marked not applicable, rather than non-compliant/i))
      .toBeInTheDocument()
  })

  it('keeps advisory standards assessed and reported, and says so', () => {
    render(<StandardForm categories={[]} busy={false} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/Advisory standards are still assessed/i)).toBeInTheDocument()
  })

  it('round-trips a saved standard', () => {
    const saved = {
      standard_id: 2, code: 'DEPS_PINNED', category: 'Supply chain', name: 'n',
      description: 'd', rationale: 'r', evidence_spec: 'e', mandatory: false,
      applies_to: ['node'], tags: [], source_document: null, owner: null,
      effective_date: null, review_date: null, active: false, sort_order: 3,
    } satisfies Standard
    expect(fromStandard(saved).mandatory).toBe(false)
    expect(fromStandard(saved).appliesTo).toEqual(['node'])
  })
})

describe('a catalogue row', () => {
  const row = (adopted: boolean) => (
    <CatalogueRow code="LAYERED" name="Layered design" group="Design"
      description="Separate concerns." adopted={adopted} busy={false}
      onToggleAdopted={vi.fn()} onEdit={vi.fn()} onRetire={vi.fn()} />
  )

  it('names the adoption control in terms of what it does', () => {
    render(row(false))
    expect(screen.getByLabelText(/Assess submissions against Layered design/i)).toBeInTheDocument()
  })

  it('reflects adoption in the control, not only in colour (P5.5)', () => {
    render(row(true))
    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  it('offers editing and retirement, but no delete', () => {
    render(row(true))
    expect(screen.getByRole('button', { name: /retire/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
  })
})
