/**
 * The pre-flight column (E46-S02 acceptance 4).
 *
 * Two properties: the failing checks are NAMED, and "could not be checked" never reads as a
 * failure — an organiser who cannot tell the two apart chases a team about the harness.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PreflightCell } from './PreflightCell.js'
import type { PreflightSummary, SubmissionRow } from '../lib/intakeApi.js'

const row = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
  submissionId: 78, teamId: 51, teamName: 'Demo Team', contactEmail: 'a@b.test',
  challengeId: 9, repoUrl: 'https://github.com/a/b', buildMethod: 'DOCKERFILE',
  version: 1, validationStatus: 'VALID', validationDetail: null,
  lockedCommitSha: null, submittedAt: '2026-10-03T13:00:00Z', submittedVia: 'TEAM_TOKEN',
  preflight: null, ...over,
})

const summary = (over: Partial<PreflightSummary> = {}): PreflightSummary => ({
  preflightId: 1, status: 'COMPLETED', verdict: 'READY', commitSha: 'a'.repeat(40),
  attention: [], error: null, noticeStatus: 'SENT', finishedAt: '2026-10-03T14:00:00Z', ...over,
})

describe('what the cell says', () => {
  it('offers to run the checks for a valid entry that was never checked', async () => {
    const onRun = vi.fn()
    render(<PreflightCell row={row()} busy={false} onRun={onRun} />)
    expect(screen.getByText('Not checked')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Run checks' }))
    expect(onRun).toHaveBeenCalledWith(78, false)
  })

  it('does not offer to check an entry that has not passed tier 1', () => {
    render(<PreflightCell row={row({ validationStatus: 'PRIVATE' })} busy={false} onRun={vi.fn()} />)
    expect(screen.getByText('Waits for tier 1')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows progress with no button while a run is live', () => {
    render(<PreflightCell row={row({ preflight: summary({ status: 'RUNNING', verdict: null }) })} busy={false} onRun={vi.fn()} />)
    expect(screen.getByText('Checking…')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('names the failing checks, and whether the team was told', () => {
    render(<PreflightCell row={row({ preflight: summary({
      verdict: 'PROBLEMS',
      attention: [{ key: 'build', label: 'Build', status: 'FAIL' }, { key: 'run', label: 'Runs', status: 'UNKNOWN' }],
    }) })} busy={false} />)
    expect(screen.getByText('PROBLEMS')).toBeInTheDocument()
    expect(screen.getByText(/: Build/)).toBeInTheDocument()
    expect(screen.getByText(/not checked: Runs/)).toBeInTheDocument()
    expect(screen.getByText('team told')).toBeInTheDocument()
  })

  it('keeps "could not be checked" distinct from a failure', () => {
    render(<PreflightCell row={row({ preflight: summary({
      verdict: 'UNKNOWN', attention: [{ key: 'build', label: 'Build', status: 'UNKNOWN' }],
    }) })} busy={false} />)
    expect(screen.getByText('Could not be checked')).toBeInTheDocument()
    expect(screen.queryByText(/PROBLEMS/)).not.toBeInTheDocument()
  })

  it('says loudly when the team was NOT told', () => {
    render(<PreflightCell row={row({ preflight: summary({ noticeStatus: 'FAILED' }) })} busy={false} />)
    expect(screen.getByText('team NOT told')).toBeInTheDocument()
  })

  it('offers "Run again" as a forced re-run once a run has settled', async () => {
    const onRun = vi.fn()
    render(<PreflightCell row={row({ preflight: summary() })} busy={false} onRun={onRun} />)
    await userEvent.click(screen.getByRole('button', { name: 'Run again' }))
    expect(onRun).toHaveBeenCalledWith(78, true)
  })

  it('shows a run that died as unfinished, with the reason', () => {
    render(<PreflightCell row={row({ preflight: summary({
      status: 'FAILED', verdict: null, error: 'The process running these checks stopped before finishing.',
    }) })} busy={false} />)
    expect(screen.getByText('Checks did not finish')).toBeInTheDocument()
    expect(screen.getByText(/stopped before finishing/)).toBeInTheDocument()
  })
})
