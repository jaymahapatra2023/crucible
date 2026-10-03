/**
 * The committee's workbench (E18).
 *
 * Two jobs the system asks of a committee and then gave them no way to do: rewriting a criterion
 * the quality gate flagged, and running the gate that decides whether this system may eliminate
 * anyone.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CriterionEditor, criterionProblems, toEdit } from './CriterionEditor.js'
import { GoldenSetBuilder } from './GoldenSetBuilder.js'
import { HandRanking } from './HandRanking.js'
import { GateCriteriaForm, GateDecision } from './GatePanel.js'
import type { CalibrationReport, RaterAgreement } from '../lib/calibrationApi.js'
import type { Criterion } from '../lib/rubricApi.js'
import type { GoldenSetDetail } from '../lib/calibrationApi.js'

const anchors = {
  '0': 'Absent.', '1': 'Mentioned only.', '2': 'Present but unproven.',
  '3': 'Works on the main path.', '4': 'Works and is tested.',
}

const criterion = (over: Partial<Criterion> = {}): Criterion => ({
  criterionId: 'c1',
  dimension: 'ENGINEERING_QUALITY',
  name: 'Handles failure without losing work',
  description: 'Whether the submission retries and surfaces failures.',
  weight: 0.6,
  evidenceSpec: 'A reader can point at the retry loop and the error handling.',
  anchors,
  sortOrder: 0,
  ...over,
} as Criterion)

describe('rewriting a criterion (E18-S01)', () => {
  it('accepts a complete criterion', () => {
    expect(criterionProblems(toEdit(criterion()))).toEqual([])
  })

  it('rejects an evidence specification too vague to select source by', () => {
    const edit = { ...toEdit(criterion()), evidenceSpec: 'good code' }
    expect(criterionProblems(edit).join(' ')).toMatch(/specific enough to select source by/i)
  })

  it('rejects two anchors that say the same thing', () => {
    // A model given identical anchors has no way to choose between those levels.
    const edit = toEdit(criterion())
    edit.anchors['2'] = 'Absent.'
    expect(criterionProblems(edit).join(' ')).toMatch(/say the same thing/i)
  })

  it('does not submit a criterion that is not ready, and says why', async () => {
    const onSave = vi.fn()
    render(<CriterionEditor
      criterion={criterion({ evidenceSpec: 'x' })} busy={false}
      onSave={onSave} onCancel={vi.fn()} onRemove={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /save criterion/i }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/not ready to save/i)
  })

  it('saves a corrected criterion', async () => {
    const onSave = vi.fn()
    render(<CriterionEditor criterion={criterion()} busy={false}
      onSave={onSave} onCancel={vi.fn()} onRemove={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /save criterion/i }))
    expect(onSave).toHaveBeenCalledOnce()
  })

  it('says what saving does to the gate flag, and what it does NOT do', async () => {
    render(<CriterionEditor criterion={criterion({ needsRewrite: true })} busy={false}
      onSave={vi.fn()} onCancel={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText(/clears the gate's flag, because it described the old wording/i))
      .toBeInTheDocument()
    expect(screen.getByText(/does not re-run the gate/i)).toBeInTheDocument()
  })

  it('warns that removing one leaves the weights not totalling 1.00', async () => {
    const onRemove = vi.fn()
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    try {
      render(<CriterionEditor criterion={criterion()} busy={false}
        onSave={vi.fn()} onCancel={vi.fn()} onRemove={onRemove} />)
      await userEvent.click(screen.getByRole('button', { name: /remove/i }))
      expect(confirm.mock.calls[0]?.[0]).toMatch(/no longer total\s+1\.00/i)
      expect(onRemove).not.toHaveBeenCalled()
    } finally {
      confirm.mockRestore()
    }
  })
})

const detail = (over: Partial<GoldenSetDetail> = {}): GoldenSetDetail => ({
  set: {
    golden_set_id: 1, name: 'Autumn set', description: '',
    status: 'OPEN', sealed_at: null, sealed_by: null,
  },
  entries: [
    {
      entry_id: 1, label: 'Strong one', repo_url: 'https://x/1',
      expected_band: 'STRONG', edge_case: null, notes: '',
    },
    {
      entry_id: 2, label: 'Scaffold', repo_url: 'https://x/2',
      expected_band: 'WEAK', edge_case: 'SCAFFOLD_ONLY', notes: '',
    },
  ],
  readiness: {
    canSeal: false, entries: 2, rankers: ['a@x'], incompleteRankers: [],
    missingEdgeCases: ['WRONG_PROBLEM'], missingBands: ['MIDDLING'],
    problems: [
      '2 of 8 repositories. Fewer cannot span clearly strong, middling and clearly weak work.',
      '1 of 2 hand rankings. One person\'s ordering cannot be distinguished from preferences.',
    ],
    warnings: [],
    agreement: null,
  },
  ...over,
})

describe('assembling the golden set (E18-S02)', () => {
  it('shows a thin set as not ready BEFORE it is used', () => {
    render(<GoldenSetBuilder detail={detail()} busy={false} onAdd={vi.fn()} onSeal={vi.fn()} />)
    expect(screen.getByText(/Not yet ready to seal/i)).toBeInTheDocument()
    expect(screen.getByText(/2 of 8 repositories/)).toBeInTheDocument()
  })

  it('blocks sealing until the set spans the range', () => {
    render(<GoldenSetBuilder detail={detail()} busy={false} onAdd={vi.fn()} onSeal={vi.fn()} />)
    expect(screen.getByRole('button', { name: /seal the set/i })).toBeDisabled()
  })

  it('says why the edge cases matter, not merely that they are missing', () => {
    render(<GoldenSetBuilder detail={detail()} busy={false} onAdd={vi.fn()} onSeal={vi.fn()} />)
    expect(screen.getByText(/most likely to be scored wrongly/i)).toBeInTheDocument()
  })

  it('offers no way to add to a sealed set', () => {
    const sealed = detail({
      set: {
        golden_set_id: 1, name: 'Autumn set', description: '',
        status: 'SEALED', sealed_at: '2026-01-01', sealed_by: 'a@x',
      },
    })
    render(<GoldenSetBuilder detail={sealed} busy={false} onAdd={vi.fn()} onSeal={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /add to the set/i })).not.toBeInTheDocument()
  })
})

describe('hand ranking (E18-S03)', () => {
  it('shows who has ranked, but nothing about HOW they ranked', () => {
    // Independence is the entire value of the exercise.
    render(<HandRanking detail={detail()} mine={[]} busy={false} onRecord={vi.fn()} />)
    expect(screen.getByText(/Ranked so far: a@x/)).toBeInTheDocument()
    expect(screen.getByText(/seeing another ranker's would destroy the independence/i))
      .toBeInTheDocument()
  })

  it('refuses a partial ordering', () => {
    render(<HandRanking detail={detail()} mine={[]} busy={false} onRecord={vi.fn()} />)
    expect(screen.getByRole('button', { name: /record my ranking/i })).toBeDisabled()
  })

  it('refuses two repositories sharing a position', async () => {
    const onRecord = vi.fn()
    render(<HandRanking detail={detail()} mine={[]} busy={false} onRecord={onRecord} />)

    await userEvent.type(screen.getByLabelText(/Position for Strong one/), '1')
    await userEvent.type(screen.getByLabelText(/Position for Scaffold/), '1')

    expect(screen.getByRole('alert')).toHaveTextContent(/share a position/i)
    expect(screen.getByRole('button', { name: /record my ranking/i })).toBeDisabled()
  })

  it('records a complete, distinct ordering', async () => {
    const onRecord = vi.fn()
    render(<HandRanking detail={detail()} mine={[]} busy={false} onRecord={onRecord} />)

    await userEvent.type(screen.getByLabelText(/Position for Strong one/), '1')
    await userEvent.type(screen.getByLabelText(/Position for Scaffold/), '2')
    await userEvent.click(screen.getByRole('button', { name: /record my ranking/i }))

    expect(onRecord).toHaveBeenCalledWith([
      { entryId: 1, position: 1 }, { entryId: 2, position: 2 },
    ])
  })

  it('says two rankers are needed when only one has ranked', () => {
    render(<HandRanking detail={detail()} mine={[]} busy={false} onRecord={vi.fn()} />)
    expect(screen.getByText(/At least two people are needed, independently/i))
      .toBeInTheDocument()
  })
})

describe('the gate criteria (E18-S04)', () => {
  it('says the criteria must precede the report, and why', () => {
    render(<GateCriteriaForm existing={null} busy={false} onRecord={vi.fn()} />)
    expect(screen.getByText(/criteria written afterwards describe whatever the report happened to say/i))
      .toBeInTheDocument()
  })

  it('demands a fallback plan written while it is still hypothetical', () => {
    render(<GateCriteriaForm existing={null} busy={false} onRecord={vi.fn()} />)
    expect(screen.getByText(/reading it at the worst possible moment/i)).toBeInTheDocument()
  })

  it('records the thresholds that were entered', async () => {
    const onRecord = vi.fn()
    render(<GateCriteriaForm existing={null} busy={false} onRecord={onRecord} />)
    await userEvent.click(screen.getByRole('button', { name: /record these criteria/i }))

    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({
      minRankCorrelation: 0.7, maxMaterialDisagreements: 2, materialRankGap: 3,
    }))
  })

  it('shows recorded criteria as settled, with who wrote them and when', () => {
    render(<GateCriteriaForm busy={false} onRecord={vi.fn()} existing={{
      criteria_id: 1, min_rank_correlation: 0.8, max_material_disagreements: 1,
      material_rank_gap: 3, max_run_variance: 10,
      fallback_plan: 'Fully human judging; evidence gathering only.',
      notes: '', recorded_by: 'chair@x', recorded_at: '2026-01-01',
    }} />)

    expect(screen.getByTestId('criteria-recorded')).toBeInTheDocument()
    expect(screen.getByText(/before any report existed/i)).toBeInTheDocument()
    expect(screen.getByText(/Fully human judging/)).toBeInTheDocument()
  })
})

describe('what the correlation was measured against (E33)', () => {
  const baseReport = {
    report_id: 1, golden_set_id: 1, rank_correlation: 0.61, correlation_note: null,
    sample_size: 11, material_disagreements: 5, disagreements: [],
    dimension_agreement: {}, run_variance: 2, generated_at: '2026-10-01T00:00:00Z',
  }

  const withRaters = (interRater: RaterAgreement): CalibrationReport =>
    ({ ...baseReport, detail: { interRater } })

  it('shows the agreement beside the coefficient, for every strength', () => {
    render(<GateDecision
      report={withRaters({
        rankers: ['alice', 'bob'], strength: 'STRONG', lowest: 0.82, mean: 0.82,
        independenceQuestioned: false,
        pairs: [{ a: 'alice', b: 'bob', rho: 0.82, n: 11 }],
        note: '2 rankers, and the least-agreeing pair is at ρ 0.820.',
      })} criteria={null} busy={false} onDecide={vi.fn()} />)

    // Shown even when it is good: a box that appears only on bad news teaches readers to read
    // its absence as "fine".
    const box = screen.getByTestId('rater-agreement')
    expect(box).toHaveTextContent('STRONG')
    expect(box).toHaveTextContent('lowest pair ρ 0.820')
  })

  it('names every pair rather than an average, so an outlier stays visible', () => {
    render(<GateDecision
      report={withRaters({
        rankers: ['alice', 'bob', 'carol'], strength: 'WEAK', lowest: -0.9, mean: 0.03,
        independenceQuestioned: false,
        pairs: [
          { a: 'alice', b: 'bob', rho: 1, n: 8 },
          { a: 'alice', b: 'carol', rho: -0.9, n: 8 },
          { a: 'bob', b: 'carol', rho: -0.9, n: 8 },
        ],
        note: 'They do not share an ordering.',
      })} criteria={null} busy={false} onDecide={vi.fn()} />)

    const box = screen.getByTestId('rater-agreement')
    expect(box).toHaveTextContent('alice vs bob: 1.000')
    expect(box).toHaveTextContent('alice vs carol: -0.900')
  })

  it('writes the strength out, never leaving it to colour alone (P5.4)', () => {
    render(<GateDecision
      report={withRaters({
        rankers: ['alice'], strength: 'NONE', lowest: null, mean: null, pairs: [],
        independenceQuestioned: false,
        note: "Only alice has ranked this set.",
      })} criteria={null} busy={false} onDecide={vi.fn()} />)

    const box = screen.getByTestId('rater-agreement')
    expect(box).toHaveTextContent('NONE')
    expect(box).toHaveTextContent('Only alice has ranked this set.')
    // No coefficient to show, and none invented.
    expect(box).not.toHaveTextContent('lowest pair')
  })

  it('shows nothing at all for a report generated before this was measured', () => {
    render(<GateDecision report={baseReport} criteria={null} busy={false} onDecide={vi.fn()} />)
    expect(screen.queryByTestId('rater-agreement')).not.toBeInTheDocument()
  })
})

describe('what to know before an irreversible seal (E33)', () => {
  it('warns about weak ranker agreement even on a set that CAN be sealed', () => {
    // The dangerous case: nothing stops this seal, so the warning is the only intervention.
    render(<GoldenSetBuilder busy={false} onAdd={vi.fn()} onSeal={vi.fn()} detail={detail({
      readiness: {
        canSeal: true, entries: 8, rankers: ['a@x', 'b@x'], incompleteRankers: [],
        missingEdgeCases: [], missingBands: [], problems: [],
        warnings: ['They do not share an ordering, so there is no stable human judgement here.'],
        agreement: {
          rankers: ['a@x', 'b@x'], strength: 'WEAK', lowest: 0.1, mean: 0.1,
          independenceQuestioned: false,
          pairs: [{ a: 'a@x', b: 'b@x', rho: 0.1, n: 8 }],
          note: 'They do not share an ordering, so there is no stable human judgement here.',
        },
      },
    })} />)

    expect(screen.getByTestId('seal-warnings'))
      .toHaveTextContent('no stable human judgement')
  })

  it('no longer calls the hand rankings "independent", which was never checked', () => {
    render(<GoldenSetBuilder busy={false} onAdd={vi.fn()} onSeal={vi.fn()} detail={detail({
      readiness: {
        canSeal: true, entries: 8, rankers: ['a@x', 'b@x'], incompleteRankers: [],
        missingEdgeCases: [], missingBands: [], problems: [], warnings: [], agreement: null,
      },
    })} />)

    expect(screen.getByTestId('set-readiness')).toHaveTextContent('2 hand rankings')
    expect(screen.getByTestId('set-readiness')).not.toHaveTextContent('independent')
  })
})
