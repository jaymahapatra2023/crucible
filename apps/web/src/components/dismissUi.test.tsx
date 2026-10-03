/**
 * Setting a security observation aside (E16-S03).
 *
 * Every observation ships with what would make it benign. This is where a reviewer records that
 * they checked it — and the property that matters most is what happens afterwards: the
 * observation stays visible and marked, because hiding it would make a checked one and an
 * unexamined one look identical.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DismissObservation } from './DismissObservation.js'
import type { Finding } from '../lib/discoveryApi.js'

const observation = (over: Partial<Finding> = {}): Finding => ({
  finding_id: 7,
  kind: 'SECURITY',
  label: 'INJECTION_RISK',
  summary: 'A query is built by interpolation.',
  detail: { concern: 'HIGH', benign_explanation: 'The caller may validate first.' },
  path: 'src/db/query.ts', line_start: 2, line_end: 3,
  excerpt: 'db.query(`... ${metric}`)', confidence: 'HIGH',
  ...over,
})

describe('an observation nobody has checked', () => {
  it('offers to record that it was checked', () => {
    render(<DismissObservation finding={observation()} busy={false}
      onDismiss={vi.fn()} onReinstate={vi.fn()} />)
    expect(screen.getByRole('button', { name: /I checked this/i })).toBeInTheDocument()
  })

  it('asks what was checked, not merely for confirmation', async () => {
    render(<DismissObservation finding={observation()} busy={false}
      onDismiss={vi.fn()} onReinstate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /I checked this/i }))
    expect(screen.getByLabelText(/What did you check\?/i)).toBeInTheDocument()
  })

  it('says who the reason is for', async () => {
    render(<DismissObservation finding={observation()} busy={false}
      onDismiss={vi.fn()} onReinstate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /I checked this/i }))
    expect(screen.getByText(/next reviewer reads this instead of repeating your work/i))
      .toBeInTheDocument()
  })

  it('will not accept a reason too short to be one', async () => {
    const onDismiss = vi.fn()
    render(<DismissObservation finding={observation()} busy={false}
      onDismiss={onDismiss} onReinstate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /I checked this/i }))
    await userEvent.type(screen.getByLabelText(/What did you check\?/i), 'fine')

    expect(screen.getByRole('button', { name: 'Set aside' })).toBeDisabled()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('records a real reason against the finding', async () => {
    const onDismiss = vi.fn()
    render(<DismissObservation finding={observation()} busy={false}
      onDismiss={onDismiss} onReinstate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /I checked this/i }))
    await userEvent.type(
      screen.getByLabelText(/What did you check\?/i),
      'The caller validates the metric against a fixed list.')
    await userEvent.click(screen.getByRole('button', { name: 'Set aside' }))

    expect(onDismiss).toHaveBeenCalledWith(
      7, 'The caller validates the metric against a fixed list.')
  })
})

describe('an observation a reviewer has checked', () => {
  const checked = observation({
    dismissed: true,
    dismissed_by: 'reviewer@test.local',
    dismissal_reason: 'The value is a documented test fixture.',
  })

  it('stays visible and says it was checked, rather than disappearing', () => {
    render(<DismissObservation finding={checked} busy={false}
      onDismiss={vi.fn()} onReinstate={vi.fn()} />)
    expect(screen.getByText(/Checked and set aside/i)).toBeInTheDocument()
  })

  it('names who checked it and what they found', () => {
    // A reader months later needs to know it was looked at, by whom, and why nobody pursued it.
    render(<DismissObservation finding={checked} busy={false}
      onDismiss={vi.fn()} onReinstate={vi.fn()} />)
    expect(screen.getByText(/reviewer@test.local/)).toBeInTheDocument()
    expect(screen.getByText(/documented test fixture/)).toBeInTheDocument()
  })

  it('can be put back', async () => {
    const onReinstate = vi.fn()
    render(<DismissObservation finding={checked} busy={false}
      onDismiss={vi.fn()} onReinstate={onReinstate} />)
    await userEvent.click(screen.getByRole('button', { name: /Put it back/i }))
    expect(onReinstate).toHaveBeenCalledWith(7)
  })
})
