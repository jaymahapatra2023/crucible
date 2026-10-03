/**
 * Linking ranked repositories to what the machine scored (E21).
 *
 * The step whose absence made the gate unreachable. Two properties matter: checking must write
 * nothing, and an entry nobody submitted has to be visible BEFORE the report refuses — because
 * the refusal names the run, which is a long way from the thing to fix.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LinkEntries } from './LinkEntries.js'
import type { LinkPlan, LinkRow } from '../lib/calibrationApi.js'

const row = (over: Partial<LinkRow> = {}): LinkRow => ({
  entryId: 1, label: 'entry-0', repoUrl: 'https://github.com/golden/repo-0',
  expectedBand: 'STRONG', edgeCase: null, submissionId: 14, teamName: 'Northwind Signals',
  outcome: 'MATCHED', detail: null, ...over,
})

const plan = (over: Partial<LinkPlan> = {}): LinkPlan => ({
  rows: [row()],
  summary: { total: 1, resolved: 1, unresolved: 0 },
  linked: false,
  refusal: null,
  ...over,
})

describe('checking what matches', () => {
  it('explains why this step exists at all', () => {
    render(<LinkEntries plan={null} busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)
    expect(screen.getByText(/No report can be produced until every entry is linked/i))
      .toBeInTheDocument()
  })

  it('offers no link button before anything has been checked', () => {
    render(<LinkEntries plan={null} busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^link /i })).not.toBeInTheDocument()
  })

  it('checks without linking', async () => {
    const onCheck = vi.fn()
    render(<LinkEntries plan={null} busy={false} onCheck={onCheck} onLink={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /check what matches/i }))
    expect(onCheck).toHaveBeenCalledOnce()
  })

  it('shows the submission each entry matched, so a mismatch is visible', async () => {
    render(<LinkEntries plan={plan()} busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)
    expect(screen.getByRole('table', { name: /entries in this set/i })).toBeInTheDocument()
    expect(screen.getByText(/#14/)).toBeInTheDocument()
    expect(screen.getByText(/Northwind Signals/)).toBeInTheDocument()
  })

  it('names the state in words, not only in colour (P5.5)', () => {
    render(<LinkEntries
      plan={plan({
        rows: [row({ outcome: 'NO_SUBMISSION', submissionId: null, teamName: null,
                     detail: 'No current submission points at this repository.' })],
        summary: { total: 1, resolved: 0, unresolved: 1 },
      })}
      busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)

    expect(screen.getByText('never submitted')).toBeInTheDocument()
    expect(screen.getByText(/No current submission points/)).toBeInTheDocument()
  })

  it('REFUSES to link while anything is unresolved, and says how many', () => {
    render(<LinkEntries
      plan={plan({
        rows: [row(), row({ entryId: 2, outcome: 'AMBIGUOUS', submissionId: null })],
        summary: { total: 2, resolved: 1, unresolved: 1 },
      })}
      busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)

    expect(screen.getByRole('button', { name: /link 2 entries/i })).toBeDisabled()
    expect(screen.getByText(/1 still unresolved/)).toBeInTheDocument()
  })

  it('says the gate cannot run while entries are unresolved', () => {
    render(<LinkEntries
      plan={plan({ summary: { total: 2, resolved: 1, unresolved: 1 } })}
      busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)
    expect(screen.getByRole('status'))
      .toHaveTextContent(/gate cannot be run until the rest are resolved/i)
  })

  it('enables linking once everything resolves', async () => {
    const onLink = vi.fn()
    render(<LinkEntries plan={plan()} busy={false} onCheck={vi.fn()} onLink={onLink} />)
    await userEvent.click(screen.getByRole('button', { name: /link 1 entry/i }))
    expect(onLink).toHaveBeenCalledOnce()
  })

  it('shows the refusal when a confirmed link was rejected whole', () => {
    render(<LinkEntries
      plan={plan({
        summary: { total: 2, resolved: 1, unresolved: 1 },
        refusal: 'Nothing was linked. 1 of 2 entries have no submission to compare against.',
      })}
      busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing was linked/)
  })

  it('offers no link button once they are linked', () => {
    render(<LinkEntries
      plan={plan({ rows: [row({ outcome: 'ALREADY_LINKED' })], linked: true })}
      busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /^link /i })).not.toBeInTheDocument()
    expect(screen.getByText('linked')).toBeInTheDocument()
  })

  it('shows the edge case an entry covers, since that is why it is in the set', () => {
    render(<LinkEntries
      plan={plan({ rows: [row({ edgeCase: 'WRONG_PROBLEM' })] })}
      busy={false} onCheck={vi.fn()} onLink={vi.fn()} />)
    expect(screen.getByText('wrong_problem')).toBeInTheDocument()
  })
})
