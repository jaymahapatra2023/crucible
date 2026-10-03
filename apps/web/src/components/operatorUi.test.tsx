/**
 * Event setup and the provenance queue (E19).
 *
 * Two settings ship unset and silently disable what depends on them, so each field has to state
 * its consequence rather than its name — a setting whose effect is invisible is one nobody sets.
 *
 * And the queue carries E04-S06's framing, which is the thing most easily lost: these are
 * FLAGS, never exclusions.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventSetup } from './EventSetup.js'
import { ProvenanceQueue } from './ProvenanceQueue.js'
import type { EventSettings, FlaggedProvenance } from '../lib/eventApi.js'

const settings = (over: Partial<EventSettings> = {}): EventSettings => ({
  evaluationDate: null, window: null, dryRunLeadDays: 7, registerUrl: null, submitUrl: null, discordInviteUrl: null, ...over,
})

describe('event setup', () => {
  it('says what the evaluation date is used for, not just its name', () => {
    render(<EventSetup settings={settings()} busy={false}
      onSaveDate={vi.fn()} onSaveWindow={vi.fn()} />)
    expect(screen.getByText(/at least 7 days before it/i)).toBeInTheDocument()
  })

  it('says what the event window is used for, and what it does NOT do', () => {
    render(<EventSetup settings={settings()} busy={false}
      onSaveDate={vi.fn()} onSaveWindow={vi.fn()} />)
    expect(screen.getByText(/flagged for a person to look at/i)).toBeInTheDocument()
    expect(screen.getByText(/never excluded, and never acted on automatically/i))
      .toBeInTheDocument()
  })

  it('will not save a date that has not been given', () => {
    render(<EventSetup settings={settings()} busy={false}
      onSaveDate={vi.fn()} onSaveWindow={vi.fn()} />)
    expect(screen.getByRole('button', { name: /save the date/i })).toBeDisabled()
  })

  it('saves the date that was entered', async () => {
    const onSaveDate = vi.fn()
    render(<EventSetup settings={settings()} busy={false}
      onSaveDate={onSaveDate} onSaveWindow={vi.fn()} />)

    await userEvent.type(screen.getByLabelText(/Evaluation date/), '2026-11-14')
    await userEvent.click(screen.getByRole('button', { name: /save the date/i }))
    expect(onSaveDate).toHaveBeenCalledWith('2026-11-14')
  })

  it('refuses a window that ends before it starts', async () => {
    render(<EventSetup settings={settings()} busy={false}
      onSaveDate={vi.fn()} onSaveWindow={vi.fn()} />)

    await userEvent.type(screen.getByLabelText(/Work could start/), '2026-11-14T09:00')
    await userEvent.type(screen.getByLabelText(/Work had to stop/), '2026-11-13T09:00')

    expect(screen.getByRole('alert')).toHaveTextContent(/must end after it starts/i)
    expect(screen.getByRole('button', { name: /save the window/i })).toBeDisabled()
  })

  it('shows values already set rather than hiding them behind an edit action', () => {
    render(<EventSetup
      settings={settings({ evaluationDate: '2026-11-14' })}
      busy={false} onSaveDate={vi.fn()} onSaveWindow={vi.fn()} />)
    expect(screen.getByLabelText(/Evaluation date/)).toHaveValue('2026-11-14')
  })
})

const flagged = (over: Partial<FlaggedProvenance> = {}): FlaggedProvenance => ({
  submission_id: 42, scan_id: 1, total_commits: 12, commits_out_of_window: 4,
  distinct_authors: 2, largest_single_commit_pct: 88, history_truncated: false,
  flags: [{ code: 'SINGLE_COMMIT', message: 'One commit contributed most of the code.' }],
  ...over,
})

describe('the provenance queue', () => {
  it('states that nothing here excludes a submission', () => {
    // E04-S06's framing, repeated where a person is about to act on it.
    render(<ProvenanceQueue entries={[flagged()]} busy={false} onResolve={vi.fn()} />)
    expect(screen.getByText(/Nothing here excludes a submission/i)).toBeInTheDocument()
  })

  it('says how many are still to look at', () => {
    render(<ProvenanceQueue
      entries={[flagged(), flagged({ submission_id: 43, resolved: true })]}
      busy={false} onResolve={vi.fn()} />)
    expect(screen.getByText(/1 of 2 still to look at/i)).toBeInTheDocument()
  })

  it('asks what was concluded, not merely for a tick', async () => {
    render(<ProvenanceQueue entries={[flagged()]} busy={false} onResolve={vi.fn()} />)
    expect(screen.getByLabelText(/What did you conclude\?/i)).toBeInTheDocument()
  })

  it('will not record a conclusion too short to be one', async () => {
    const onResolve = vi.fn()
    render(<ProvenanceQueue entries={[flagged()]} busy={false} onResolve={onResolve} />)
    await userEvent.type(screen.getByLabelText(/What did you conclude\?/i), 'fine')

    expect(screen.getByRole('button', { name: /record this/i })).toBeDisabled()
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('records a real conclusion against the submission', async () => {
    const onResolve = vi.fn()
    render(<ProvenanceQueue entries={[flagged()]} busy={false} onResolve={onResolve} />)
    await userEvent.type(
      screen.getByLabelText(/What did you conclude\?/i),
      'The team squashed their history before submitting.')
    await userEvent.click(screen.getByRole('button', { name: /record this/i }))

    expect(onResolve).toHaveBeenCalledWith(42, 'The team squashed their history before submitting.')
  })

  it('keeps a resolved entry visible, marked, with what was concluded', () => {
    render(<ProvenanceQueue
      entries={[flagged({
        resolved: true,
        resolved_by: 'organiser@test.local',
        resolution_reason: 'Squashed history; authors confirmed.',
      })]}
      busy={false} onResolve={vi.fn()} />)

    expect(screen.getByTestId('provenance-42')).toHaveAttribute('data-resolved', 'true')
    expect(screen.getByText(/Looked at/)).toBeInTheDocument()
    expect(screen.getByText(/Squashed history; authors confirmed/)).toBeInTheDocument()
  })

  it('warns that an empty queue may mean nothing is configured', () => {
    // Otherwise "no flags" reads as "all clear" when it may mean the window was never set.
    render(<ProvenanceQueue entries={[]} busy={false} onResolve={vi.fn()} />)
    expect(screen.getByText(/flagging needs an event window to be set/i)).toBeInTheDocument()
  })

  it('says when the figures cover only part of the history', () => {
    render(<ProvenanceQueue entries={[flagged({ history_truncated: true })]}
      busy={false} onResolve={vi.fn()} />)
    expect(screen.getByText(/cover only part of it/i)).toBeInTheDocument()
  })
})
