/**
 * Batch progress display (E10-S05, E10-S02, E10-S03).
 *
 * An operator reads this at 3am to decide whether to intervene. So the tests are about the
 * honest cases: an estimate that is not yet measurable, a run that paused for budget, and
 * failures that must read as recorded-and-continued rather than as a broken run.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BatchProgressView } from './BatchProgressView.js'
import type { BatchProgress } from '../lib/batchApi.js'

const progress = (overrides: Partial<BatchProgress> = {}): BatchProgress => ({
  runId: 12, status: 'RUNNING',
  startedAt: '2026-03-01T22:00:00.000Z', finishedAt: null,
  costUsd: 18.5, estimatedFinishAt: '2026-03-02T02:30:00.000Z', projectedCostUsd: 92.25,
  currentStage: 'score', currentSubject: '7', currentLabel: 'Team Alpha',
  completed: 20, total: 50,
  stages: [
    { stage: 'scan', ok: 50, failed: 0, skipped: 0, done: 50 },
    { stage: 'probe', ok: 48, failed: 2, skipped: 0, done: 50 },
    { stage: 'score', ok: 20, failed: 0, skipped: 0, done: 20 },
  ],
  failures: [], pausedReason: null, costBySubmission: [],
  ...overrides,
})

describe('progress per stage (acceptance 1)', () => {
  it('shows every stage with its counts', () => {
    render(<BatchProgressView progress={progress()} />)

    expect(screen.getByTestId('stage-scan')).toHaveTextContent('50 of 50')
    expect(screen.getByTestId('stage-probe')).toHaveTextContent('2')
    expect(screen.getByTestId('stage-score')).toHaveTextContent('20 of 50')
  })

  it('names the item being worked on right now', () => {
    render(<BatchProgressView progress={progress()} />)
    expect(screen.getByTestId('current-item')).toHaveTextContent('Team Alpha')
    expect(screen.getByTestId('current-item')).toHaveTextContent(/Scoring against the rubric/)
  })

  it('does not claim a current item once the run has stopped', () => {
    render(<BatchProgressView progress={progress({ status: 'SUCCEEDED' })} />)
    expect(screen.queryByTestId('current-item')).not.toBeInTheDocument()
  })

  it('counts steps across every stage, not submissions', () => {
    render(<BatchProgressView progress={progress()} />)
    // 50 + 50 + 20 done, of 50 × 3 expected.
    expect(screen.getByTestId('overall-progress')).toHaveTextContent('120 of 150 steps')
  })
})

describe('estimates are measured or absent (E10-S02 acceptance 3)', () => {
  it('shows the expected finish when it has been measured', () => {
    render(<BatchProgressView progress={progress()} />)
    expect(screen.getByTestId('eta')).toHaveTextContent(/expected to finish/)
  })

  it('SAYS the finish time is unknown rather than hiding the line', () => {
    render(<BatchProgressView progress={progress({ estimatedFinishAt: null })} />)
    // An operator who sees nothing assumes the page is broken; this tells them it is unmeasured.
    expect(screen.getByTestId('eta')).toHaveTextContent('finish time not yet known')
  })

  it('omits a projection that is not yet available', () => {
    render(<BatchProgressView progress={progress({ projectedCostUsd: null })} />)
    expect(screen.queryByTestId('projected')).not.toBeInTheDocument()
    // Spend so far is still shown: that is measured.
    expect(screen.getByTestId('cost')).toHaveTextContent('$18.50 spent')
  })

  it('shows the projection alongside the spend when it is', () => {
    render(<BatchProgressView progress={progress()} />)
    expect(screen.getByTestId('projected')).toHaveTextContent('$92.25 projected')
  })
})

describe('a paused run (E10-S03 acceptance 2)', () => {
  it('shows the reason it stopped', () => {
    render(<BatchProgressView progress={progress({
      status: 'PAUSED',
      pausedReason: 'At the current rate this run would cost about $400.00, above the $250.00 ceiling.',
    })} />)

    expect(screen.getByTestId('run-status')).toHaveTextContent('PAUSED')
    expect(screen.getByTestId('paused-reason')).toHaveTextContent(/would cost about \$400\.00/)
  })

  it('shows no pause banner on a healthy run', () => {
    render(<BatchProgressView progress={progress()} />)
    expect(screen.queryByTestId('paused-reason')).not.toBeInTheDocument()
  })
})

describe('failures (E10-S04 acceptance 4)', () => {
  it('lists each failure with its stage and reason', () => {
    render(<BatchProgressView progress={progress({
      failures: [
        { stage: 'scan', subjectId: '7', message: 'the repository vanished mid-clone' },
        { stage: 'probe', subjectId: '9', message: 'no build recipe for this stack' },
      ],
    })} />)

    expect(screen.getByText(/the repository vanished mid-clone/)).toBeInTheDocument()
    expect(screen.getByText(/no build recipe for this stack/)).toBeInTheDocument()
  })

  it('says a failed submission was left UNMEASURED, not scored down', () => {
    render(<BatchProgressView progress={progress({
      failures: [{ stage: 'scan', subjectId: '7', message: 'gone' }],
    })} />)
    expect(screen.getByText(/left unmeasured/)).toBeInTheDocument()
  })

  it('shows no failure section when there are none', () => {
    render(<BatchProgressView progress={progress()} />)
    expect(screen.queryByText(/failure/i)).not.toBeInTheDocument()
  })
})
