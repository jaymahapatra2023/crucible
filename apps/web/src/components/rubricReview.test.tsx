/**
 * Rubric review UI tests (E02-S06 acceptance 2, 3 and 4).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WeightEditor } from './WeightEditor.js'
import { DimensionWeights } from './DimensionWeights.js'
import { CriterionCard } from './CriterionCard.js'
import { ApprovalPanel } from './ApprovalPanel.js'
import type { Criterion, Readiness } from '../lib/rubricApi.js'

const anchors = {
  '0': 'No evidence.', '1': 'Mentioned only.', '2': 'Present but unused.',
  '3': 'Works on the main path.', '4': 'Works, validated and tested.',
}

function criterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    criterionId: 'c1',
    dimension: 'CHALLENGE_FIDELITY',
    name: 'Ingests the telemetry feed',
    description: 'Whether the submission consumes the provided feed.',
    weight: 0.6,
    evidenceSpec: 'A reader can point to the connection code and the parser.',
    anchors,
    sourceRef: 'brief §2.1',
    sortOrder: 0,
    ...overrides,
  }
}

const readiness = (overrides: Partial<Readiness['report']> = {}): Readiness => {
  const report = { valid: true, errors: [], warnings: [], ...overrides }
  return {
    canApprove: report.errors.length === 0 && report.warnings.length === 0,
    unacknowledgedWarnings: report.warnings.map((w) => w.code),
    report,
  }
}

describe('WeightEditor — running total (E02-S06 acceptance 2)', () => {
  const two = [criterion(), criterion({ criterionId: 'c2', name: 'Detects breaches', weight: 0.4 })]

  it('shows the running total of the dimension', () => {
    render(<WeightEditor dimension="CHALLENGE_FIDELITY" criteria={two} disabled={false} onSave={vi.fn()} />)
    expect(screen.getByTestId('total-CHALLENGE_FIDELITY')).toHaveTextContent('1.00')
  })

  it('updates the total as weights are edited, and flags it when it is not 1.00', async () => {
    render(<WeightEditor dimension="CHALLENGE_FIDELITY" criteria={two} disabled={false} onSave={vi.fn()} />)
    const input = screen.getByLabelText('Weight for Ingests the telemetry feed')

    await userEvent.clear(input)
    await userEvent.type(input, '0.5')

    expect(screen.getByTestId('total-CHALLENGE_FIDELITY')).toHaveTextContent('0.90')
    expect(screen.getByText('must be 1.00')).toBeInTheDocument()
  })

  it('never silently rescales the reviewer’s numbers', async () => {
    const onSave = vi.fn(async () => undefined)
    render(<WeightEditor dimension="CHALLENGE_FIDELITY" criteria={two} disabled={false} onSave={onSave} />)

    const input = screen.getByLabelText('Weight for Detects breaches')
    await userEvent.clear(input)
    await userEvent.type(input, '0.3')
    await userEvent.click(screen.getByRole('button', { name: /save weights/i }))

    // Exactly what was typed is sent — 0.6 and 0.3, not a normalised 0.67 / 0.33.
    expect(onSave).toHaveBeenCalledWith({ c1: 0.6, c2: 0.3 })
  })

  it('is read-only once the rubric is no longer editable', () => {
    render(<WeightEditor dimension="CHALLENGE_FIDELITY" criteria={two} disabled onSave={vi.fn()} />)
    expect(screen.getByLabelText('Weight for Detects breaches')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /save weights/i })).toBeNull()
  })

  it('renders nothing for a dimension with no criteria', () => {
    const { container } = render(
      <WeightEditor dimension="RUNS" criteria={two} disabled={false} onSave={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('CriterionCard — provenance and gate notes (acceptance 3 and 4)', () => {
  it('shows the source reference back to the brief', () => {
    render(<CriterionCard criterion={criterion()} challengeId="1" />)
    expect(screen.getByText(/From the brief:/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'brief §2.1' })).toBeInTheDocument()
  })

  it('shows the evidence specification, which is what makes it scoreable', () => {
    render(<CriterionCard criterion={criterion()} challengeId="1" />)
    expect(screen.getByText(/A reader can point to the connection code/)).toBeInTheDocument()
  })

  it('shows all five anchors', async () => {
    render(<CriterionCard criterion={criterion()} challengeId="1" />)
    await userEvent.click(screen.getByText('Score anchors'))
    for (const text of Object.values(anchors)) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
  })

  it('surfaces a quality-gate flag prominently, with its reasons', () => {
    render(<CriterionCard challengeId="1" criterion={criterion({
      needsRewrite: true,
      gateNotes: ['"innovative" cannot be located in a repository'],
    })} />)
    expect(screen.getByText('Needs rewrite')).toBeInTheDocument()
    expect(screen.getByText(/cannot be located in a repository/)).toBeInTheDocument()
  })

  it('shows no gate warning for a clean criterion', () => {
    render(<CriterionCard criterion={criterion()} challengeId="1" />)
    expect(screen.queryByText('Needs rewrite')).toBeNull()
  })
})

describe('ApprovalPanel — blocking (acceptance 2 and 4)', () => {
  const noop = vi.fn()

  it('enables approval when there is nothing outstanding', () => {
    render(<ApprovalPanel readiness={readiness()} status="DRAFT" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
  })

  it('BLOCKS approval while an error stands, and says what it is', () => {
    const r = readiness({
      valid: false,
      errors: [{ severity: 'error', code: 'DIMENSION_WEIGHTS_NOT_ONE',
        message: 'Criterion weights in CHALLENGE_FIDELITY sum to 0.9000, not 1.0' }],
    })
    render(<ApprovalPanel readiness={r} status="DRAFT" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('sum to 0.9000')
  })

  it('BLOCKS approval until every warning is explicitly acknowledged', async () => {
    const r = readiness({
      warnings: [{ severity: 'warning', code: 'NEEDS_REWRITE',
        message: 'The quality gate could not make this criterion checkable' }],
    })
    const onApprove = vi.fn()
    render(<ApprovalPanel readiness={r} status="DRAFT" busy={false}
      onApprove={onApprove} onFreeze={noop} onPublish={noop} />)

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledWith(['NEEDS_REWRITE'])
  })

  it('re-blocks if an acknowledgement is withdrawn', async () => {
    const r = readiness({
      warnings: [{ severity: 'warning', code: 'NEEDS_REWRITE', message: 'gate concern' }],
    })
    render(<ApprovalPanel readiness={r} status="DRAFT" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)

    const box = screen.getByRole('checkbox')
    await userEvent.click(box)
    await userEvent.click(box)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('offers freeze only once approved, and publish only once frozen', () => {
    const { rerender } = render(<ApprovalPanel readiness={readiness()} status="DRAFT" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)
    expect(screen.getByRole('button', { name: 'Freeze' })).toBeDisabled()

    rerender(<ApprovalPanel readiness={readiness()} status="APPROVED" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)
    expect(screen.getByRole('button', { name: 'Freeze' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /publish/i })).toBeDisabled()

    rerender(<ApprovalPanel readiness={readiness()} status="FROZEN" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)
    expect(screen.getByRole('button', { name: /publish/i })).toBeEnabled()
  })

  it('explains why approval is unavailable rather than leaving a dead button', () => {
    const r = readiness({
      warnings: [{ severity: 'warning', code: 'NEEDS_REWRITE', message: 'gate concern' }],
    })
    render(<ApprovalPanel readiness={r} status="DRAFT" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)
    expect(screen.getByText(/Acknowledge every warning above/)).toBeInTheDocument()
  })

  it('labels the acknowledgement group so it is reachable by assistive tech', () => {
    const r = readiness({
      warnings: [{ severity: 'warning', code: 'NEEDS_REWRITE', message: 'gate concern' }],
    })
    render(<ApprovalPanel readiness={r} status="DRAFT" busy={false}
      onApprove={noop} onFreeze={noop} onPublish={noop} />)
    const group = screen.getByRole('group', { name: /acknowledge before approving/i })
    expect(within(group).getByRole('checkbox')).toBeInTheDocument()
  })
})

describe('dimension weights (E02-S06, E07-S02)', () => {
  const weights = {
    CHALLENGE_FIDELITY: 0.4, ENGINEERING_QUALITY: 0.3,
    PRINCIPLES_STANDARDS: 0.2, RUNS: 0.1, ORIGINALITY: 0,
  }

  it('shows the running total continuously', () => {
    render(<DimensionWeights weights={weights} disabled={false} onSave={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Total 1.00')
  })

  it('refuses to save weights that do not total one, and says nothing is rescaled', async () => {
    render(<DimensionWeights weights={{ ...weights, RUNS: 0.5 }} disabled={false}
      onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: /save dimension weights/i })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing is rescaled for you/)
  })

  it('says a zero-weighted dimension is not assessed, not merely unimportant', () => {
    render(<DimensionWeights weights={weights} disabled={false} onSave={vi.fn()} />)
    expect(screen.getByText(/— not scored at all/)).toBeInTheDocument()
    expect(screen.getByText(/different from being assessed and scoring badly/i))
      .toBeInTheDocument()
  })

  it('saves the weights the committee actually entered', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<DimensionWeights weights={weights} disabled={false} onSave={onSave} />)
    await userEvent.click(screen.getByRole('button', { name: /save dimension weights/i }))
    expect(onSave).toHaveBeenCalledWith(weights)
  })

  it('cannot be edited once the rubric is frozen', () => {
    render(<DimensionWeights weights={weights} disabled onSave={vi.fn()} />)
    for (const input of screen.getAllByLabelText(/Weight for /)) expect(input).toBeDisabled()
  })
})
