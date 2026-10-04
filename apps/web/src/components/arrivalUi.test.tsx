/**
 * Coach arrival on screen (migration 105).
 *
 * The headline is TEAMS uncovered rather than coaches missing, because an organiser deciding who
 * to redeploy needs the number that counts teams.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ArrivalPanel } from './ArrivalPanel.js'
import type { ArrivalSummary, CoachArrival } from '../lib/arrivalApi.js'

const coach = (over: Partial<CoachArrival> = {}): CoachArrival => ({
  coachId: 1, fullName: 'Margaret Hamilton', email: 'margaret@example.test',
  organisation: null, teamCapacity: 2, arrivedAt: null, arrived: false,
  teamsAssigned: 2, teamsUncovered: 2, ...over,
})

const summary = (coaches: CoachArrival[]): ArrivalSummary => ({
  coaches,
  summary: {
    total: coaches.length,
    arrived: coaches.filter((c) => c.arrived).length,
    missing: coaches.filter((c) => !c.arrived).length,
    teamsUncovered: coaches.reduce((n, c) => n + c.teamsUncovered, 0),
  },
})

const props = { busy: false, onRefresh: vi.fn() }

describe('the arrival panel', () => {
  it('leads with teams uncovered, not coaches missing', () => {
    // Three coaches missing can mean anything from three teams to six.
    render(<ArrivalPanel {...props} state={summary([
      coach(), coach({ coachId: 2, fullName: 'Katherine J', teamsAssigned: 1, teamsUncovered: 1 }),
    ])} />)
    expect(screen.getByTestId('teams-uncovered')).toHaveTextContent('3')
    expect(screen.getByText(/0 of 2 coaches confirmed/)).toBeInTheDocument()
  })

  it('lists only the coaches who have not confirmed', () => {
    render(<ArrivalPanel {...props} state={summary([
      coach(),
      coach({ coachId: 2, fullName: 'Katherine J', arrived: true, arrivedAt: '2026-10-03T13:00:00Z', teamsUncovered: 0 }),
    ])} />)
    const table = screen.getByRole('table', { name: 'Coaches who have not confirmed' })
    expect(table).toHaveTextContent('Margaret Hamilton')
    expect(table).not.toHaveTextContent('Katherine J')
  })

  it('says so plainly when everybody has confirmed', () => {
    render(<ArrivalPanel {...props} state={summary([
      coach({ arrived: true, arrivedAt: '2026-10-03T13:00:00Z', teamsUncovered: 0 }),
    ])} />)
    expect(screen.getByText('Every coach has confirmed.')).toBeInTheDocument()
    expect(screen.getByTestId('teams-uncovered')).toHaveTextContent('0')
  })

  it('distinguishes a missing coach with no teams from one holding two', () => {
    render(<ArrivalPanel {...props} state={summary([
      coach(),
      coach({ coachId: 2, fullName: 'Spare Coach', teamsAssigned: 0, teamsUncovered: 0 }),
    ])} />)
    expect(screen.getByText('none assigned yet')).toBeInTheDocument()
    expect(screen.getByTestId('teams-uncovered')).toHaveTextContent('2')
  })

  it('shows only the refresh control before anything has loaded', () => {
    render(<ArrivalPanel {...props} state={null} />)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.queryByTestId('teams-uncovered')).not.toBeInTheDocument()
  })

  it('asks for a refresh when told to', async () => {
    const onRefresh = vi.fn()
    const user = userEvent.setup()
    render(<ArrivalPanel {...props} onRefresh={onRefresh} state={null} />)
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
