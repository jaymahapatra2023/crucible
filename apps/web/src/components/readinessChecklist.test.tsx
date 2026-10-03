/**
 * The readiness checklist (plan §IV.5).
 *
 * Read on the night by somebody deciding whether to proceed, so the tests are about the two
 * distinctions that matter: showing WHAT WAS FOUND rather than a tick, and keeping "could not
 * check" separate from "not done" — collapsing those is how an unchecked item becomes an
 * assumed one.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReadinessChecklist } from './ReadinessChecklist.js'
import type { ReadinessReport } from '../lib/readinessApi.js'

const report = (overrides: Partial<ReadinessReport> = {}): ReadinessReport => ({
  cohortKey: 'c', ready: false,
  checks: [
    {
      id: 'rubric_frozen', statement: 'A frozen, published rubric exists for each challenge.',
      status: 'PASS', detail: '2 challenges, each with a frozen and published rubric.',
    },
    {
      id: 'submission_evidence',
      statement: 'Every submission has a validated repo URL, a commit SHA and a probe result.',
      status: 'FAIL', detail: 'Of 50 submissions: 2 never probed.',
    },
    {
      id: 'cut_band', statement: 'Every flag in the cut band was reviewed by a person.',
      status: 'UNKNOWN', detail: 'No ranking with a cut band exists for this cohort yet.',
    },
  ],
  ...overrides,
})

describe('what each statement shows', () => {
  it('shows WHAT WAS FOUND, not merely whether it passed', () => {
    render(<ReadinessChecklist report={report()} />)
    // "2 never probed" tells an operator what to do; a red cross does not.
    expect(screen.getByText(/2 never probed/)).toBeInTheDocument()
  })

  it('carries the plan’s own wording for each statement', () => {
    render(<ReadinessChecklist report={report()} />)
    expect(screen.getByText(/A frozen, published rubric exists/)).toBeInTheDocument()
  })

  it('KEEPS "could not check" distinct from "not done"', () => {
    render(<ReadinessChecklist report={report()} />)
    expect(screen.getByTestId('check-cut_band')).toHaveAttribute('data-status', 'UNKNOWN')
    expect(screen.getByTestId('check-submission_evidence')).toHaveAttribute('data-status', 'FAIL')
    expect(screen.getByTestId('check-cut_band')).toHaveTextContent('could not check')
  })

  it('shows completed statements too, not only the outstanding ones', () => {
    render(<ReadinessChecklist report={report()} />)
    expect(screen.getByTestId('check-rubric_frozen')).toHaveAttribute('data-status', 'PASS')
  })
})

describe('the heading', () => {
  it('counts everything that is not done, including unknowns', () => {
    render(<ReadinessChecklist report={report()} />)
    expect(screen.getByRole('heading', { name: /2 of 3 outstanding/ })).toBeInTheDocument()
  })

  it('says so plainly when every statement holds', () => {
    render(<ReadinessChecklist report={report({
      ready: true,
      checks: [{
        id: 'x', statement: 'Everything is fine.', status: 'PASS', detail: 'All good here.',
      }],
    })} />)
    expect(screen.getByRole('heading', { name: /every statement holds/ })).toBeInTheDocument()
  })
})
