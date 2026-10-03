/**
 * UI state component tests (P5.4, P5.7).
 *
 * The property under test is the one P5.7 exists for: a reviewer must never be able to mistake
 * a failed fetch for an empty result, because that mistake changes who gets eliminated.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorState } from './ErrorState.js'
import { EmptyState } from './EmptyState.js'
import { LoadingState } from './LoadingState.js'

describe('ErrorState', () => {
  it('is announced as an alert', () => {
    render(<ErrorState title="Runs failed" message="The API is unreachable." />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('explains what happened in plain language, not a status code (P5.4)', () => {
    render(<ErrorState title="Runs failed" message="The API is unreachable." />)
    expect(screen.getByText('The API is unreachable.')).toBeInTheDocument()
  })

  it('offers a retry rather than a dead end (P5.4)', async () => {
    const onRetry = vi.fn()
    render(<ErrorState title="t" message="m" onRetry={onRetry} />)
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps technical detail behind progressive disclosure (P5.2)', () => {
    render(<ErrorState title="t" message="m" detail="UPSTREAM_UNAVAILABLE" />)
    expect(screen.getByText('View details')).toBeInTheDocument()
  })

  it('never renders as a zero or an empty result', () => {
    const { container } = render(<ErrorState title="Failed" message="Could not load." />)
    expect(container.textContent).not.toMatch(/^0$/)
    expect(container.textContent).toContain('Failed')
  })
})

describe('EmptyState', () => {
  it('tells the user what needs to happen next (P5.4)', () => {
    render(<EmptyState title="No runs yet" explanation="Start one from the batch console." />)
    expect(screen.getByText(/start one from the batch console/i)).toBeInTheDocument()
  })

  it('is NOT an alert — an empty result is not a failure', () => {
    render(<EmptyState title="No runs yet" explanation="x" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('LoadingState', () => {
  it('is announced politely without stealing focus (P5.5)', () => {
    render(<LoadingState label="Loading runs" />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent(/loading runs/i)
  })
})

describe('empty and error are visually and semantically distinct (P5.7)', () => {
  it('uses different ARIA roles so assistive tech distinguishes them', () => {
    const { unmount } = render(<ErrorState title="e" message="m" />)
    expect(screen.queryByRole('alert')).not.toBeNull()
    unmount()
    render(<EmptyState title="n" explanation="x" />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('n')).toBeInTheDocument()
  })
})
