/**
 * The public confirm form and the organiser queue (migration 104).
 *
 * What matters on screen: the form shows nothing back, and each queued row says plainly whether
 * approving ADDS somebody or CORRECTS somebody, because those are different acts and an
 * organiser is doing twenty of them at a desk while people wait.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CorrectionQueue } from './CorrectionQueue.js'
import type { Correction } from '../lib/confirmApi.js'

const row = (over: Partial<Correction> = {}): Correction => ({
  correctionId: 1, claimedName: 'Teddy Tennant', claimedEmail: 'teddy@real.test',
  participantId: 7, currentName: 'Teddy Tennant', currentEmail: 'placeholder@local.test',
  organisation: null, matched: true, kind: 'CORRECTION', onATeam: false,
  status: 'PENDING', createdAt: '2026-10-03T12:00:00Z', ...over,
})

const props = { busy: false, canDecide: true, onDecide: vi.fn() }

describe('the organiser queue', () => {
  it('says nothing is waiting when nothing is', () => {
    render(<CorrectionQueue {...props} corrections={[]} />)
    expect(screen.getByText('Nothing waiting.')).toBeInTheDocument()
  })

  it('leads with the count, split by what each one would do', () => {
    render(<CorrectionQueue {...props} corrections={[
      row(), row({ correctionId: 2, kind: 'ADD', matched: false, participantId: null }),
      row({ correctionId: 3, kind: 'ADD', matched: false, participantId: null }),
    ]} />)
    expect(screen.getByTestId('corrections-waiting')).toHaveTextContent('3')
    expect(screen.getByText(/2 to add/)).toBeInTheDocument()
    expect(screen.getByText(/1 to correct/)).toBeInTheDocument()
  })

  it('states in words whether approving adds or corrects', () => {
    render(<CorrectionQueue {...props} corrections={[
      row(), row({ correctionId: 2, kind: 'ADD', matched: false, participantId: null,
        currentName: null, currentEmail: null }),
    ]} />)
    expect(screen.getByText('Correct their details')).toBeInTheDocument()
    expect(screen.getByText('Add a new person')).toBeInTheDocument()
    // And says plainly that nobody of that name is held, rather than showing a blank cell.
    expect(screen.getByText('nobody of that name')).toBeInTheDocument()
  })

  it('shows the before and the after side by side', () => {
    render(<CorrectionQueue {...props} corrections={[row()]} />)
    expect(screen.getByText('teddy@real.test')).toBeInTheDocument()
    expect(screen.getByText('placeholder@local.test')).toBeInTheDocument()
  })

  it('warns when the person is already on a team', () => {
    // Approving then redirects that team's emails, including the one carrying their code.
    render(<CorrectionQueue {...props} corrections={[row({ onATeam: true })]} />)
    expect(screen.getByText(/their team’s emails will follow the new address/i)).toBeInTheDocument()
  })

  it('hides a decided row', () => {
    render(<CorrectionQueue {...props} corrections={[row({ status: 'APPLIED' })]} />)
    expect(screen.getByText('Nothing waiting.')).toBeInTheDocument()
  })

  it('offers no buttons below organiser, but still shows the queue', () => {
    render(<CorrectionQueue {...props} canDecide={false} corrections={[row()]} />)
    expect(screen.getByTestId('corrections-waiting')).toHaveTextContent('1')
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('passes the decision up with the id', async () => {
    const onDecide = vi.fn()
    const user = userEvent.setup()
    render(<CorrectionQueue {...props} onDecide={onDecide} corrections={[row({ correctionId: 42 })]} />)
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onDecide).toHaveBeenCalledWith(42, true)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDecide).toHaveBeenCalledWith(42, false)
  })

  it('labels the button Add when that is what it would do', async () => {
    render(<CorrectionQueue {...props} corrections={[
      row({ kind: 'ADD', matched: false, participantId: null, currentName: null }),
    ]} />)
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})
