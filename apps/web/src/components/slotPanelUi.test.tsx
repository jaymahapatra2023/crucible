/**
 * The floor plan on screen (migration 095).
 *
 * The number that matters is how many slots are still free, because it decides whether the next
 * team through the door has somewhere to sit. An exhausted pool is not an error, and the panel
 * has to say what happens instead rather than looking broken.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SlotPanel } from './SlotPanel.js'
import type { SlotPlan, SlotStatus, TeamSlot } from '../lib/rosterApi.js'

const slot = (over: Partial<TeamSlot> = {}): TeamSlot => ({
  team_id: 1, slot_label: 'Team 1', display_name: 'Team 1', claimed_at: null,
  available: true, room_label: 'Hall A', coach_name: 'Margaret Hamilton',
  coach_email: 'margaret@example.test', ...over,
})

const status = (over: Partial<SlotStatus> = {}): SlotStatus => ({
  total: 3, available: 2, claimed: 1, withoutRoom: 0, withoutCoach: 0, ...over,
})

const props = {
  status: status(), slots: [slot()], plan: null, busy: false, failure: null, csv: '',
  onCsvChange: vi.fn(), onPlan: vi.fn(), onProvision: vi.fn(),
}

describe('the pool', () => {
  it('leads with how many slots are free', () => {
    render(<SlotPanel {...props} />)
    expect(screen.getByTestId('slots-available')).toHaveTextContent('2')
    expect(screen.getByText(/of 3 slots still free · 1 claimed/)).toBeInTheDocument()
  })

  it('explains what to do when nothing is provisioned yet', () => {
    render(<SlotPanel {...props} status={status({ total: 0, available: 0, claimed: 0 })} slots={[]} />)
    expect(screen.getByText(/Nothing provisioned yet/)).toBeInTheDocument()
  })

  it('says an exhausted pool does NOT stop teams registering', () => {
    // The worst reading of "0 free" would be that registration is now closed.
    render(<SlotPanel {...props} status={status({ available: 0, claimed: 3 })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Teams can still register/)
    expect(screen.getByRole('status')).toHaveTextContent(/no room or coach until you place them/)
  })

  it('names slots that are missing a room or a coach', () => {
    render(<SlotPanel {...props} status={status({ withoutRoom: 2, withoutCoach: 1 })} />)
    expect(screen.getByText(/2 slot\(s\) have no room/)).toBeInTheDocument()
    expect(screen.getByText(/1 slot\(s\) have no coach/)).toBeInTheDocument()
  })
})

describe('the list', () => {
  it('shows free slots, and hides claimed ones until asked', async () => {
    const slots = [slot(), slot({
      team_id: 2, slot_label: 'Team 2', display_name: 'Night Shift',
      available: false, claimed_at: '2026-10-03T18:00:00Z',
    })]
    render(<SlotPanel {...props} slots={slots} />)

    expect(screen.getByText('Team 1')).toBeInTheDocument()
    expect(screen.queryByText('Night Shift')).not.toBeInTheDocument()

    await userEvent.click(screen.getByLabelText(/show claimed slots too/))
    expect(screen.getByText('Night Shift')).toBeInTheDocument()
  })

  it('writes out a missing room rather than leaving the cell blank', () => {
    render(<SlotPanel {...props} slots={[slot({ room_label: null, coach_name: null })]} />)
    expect(screen.getByText('no room')).toBeInTheDocument()
    expect(screen.getByText('no coach')).toBeInTheDocument()
  })
})

describe('provisioning', () => {
  it('checks the file before offering to provision it', async () => {
    const onPlan = vi.fn()
    render(<SlotPanel {...props} csv="label,room,coach" onPlan={onPlan} />)

    expect(screen.queryByRole('button', { name: /Provision/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Check the file' }))
    expect(onPlan).toHaveBeenCalled()
  })

  it('says a coach is over the number of teams they agreed to', () => {
    // 34 coaches who between them agreed to 48 teams cannot cover 52 slots. The coach who finds
    // out on the day is the wrong person to discover it.
    const plan: SlotPlan = {
      rows: [], summary: { total: 3, new: 3, existing: 0, invalid: 0 },
      coachLoad: [{ coach: 'Josh Humpherys', slots: 3, teamCapacity: 2, overTeamCapacity: true }],
      roomLoad: [],
      provisioned: false, refusal: null,
    }
    render(<SlotPanel {...props} csv="x" plan={plan} />)
    expect(screen.getByText(/Josh Humpherys 3/)).toBeInTheDocument()
    expect(screen.getByText(/over by 1/)).toBeInTheDocument()
  })

  it('says a room is over its TEAM limit, in words and by how much', () => {
    // The case the seat count could never show: the Dining Room seats 100 people and takes 12
    // teams, so a thirteenth slot there is a problem the people figure calls fine.
    const plan: SlotPlan = {
      rows: [], summary: { total: 13, new: 13, existing: 0, invalid: 0 },
      coachLoad: [],
      roomLoad: [{
        room: 'Dining Room', slots: 13, capacity: 100, teamCapacity: 12, overTeamCapacity: true,
      }],
      provisioned: false, refusal: null,
    }
    render(<SlotPanel {...props} csv="x" plan={plan} />)
    expect(screen.getByText(/Dining Room 13/)).toBeInTheDocument()
    expect(screen.getByText(/over by 1/)).toBeInTheDocument()
  })

  it('offers to provision once a plan has no unusable rows', () => {
    const plan: SlotPlan = {
      rows: [], summary: { total: 2, new: 2, existing: 0, invalid: 0 },
      coachLoad: [],
      roomLoad: [{
        room: 'Hall A', slots: 2, capacity: 40, teamCapacity: 4, overTeamCapacity: false,
      }],
      provisioned: false, refusal: null,
    }
    render(<SlotPanel {...props} csv="x" plan={plan} />)
    expect(screen.getByRole('button', { name: 'Provision 2 new' })).toBeEnabled()
    expect(screen.getByText(/Hall A 2/)).toBeInTheDocument()
    // Against the TEAM limit, which is what "how many slots fit here" means (migration 101).
    expect(screen.getByText(/of 4/)).toBeInTheDocument()
  })

  it('will NOT offer to provision a file with an unusable row, and says which', () => {
    const plan: SlotPlan = {
      rows: [{
        line: 4, label: 'Team 4', roomLabel: 'Hall Z', coachName: '', outcome: 'INVALID',
        detail: 'No room called "Hall Z". Upload the rooms first.', teamId: null,
      }],
      summary: { total: 4, new: 3, existing: 0, invalid: 1 },
      coachLoad: [],
      roomLoad: [], provisioned: false,
      refusal: 'Nothing was provisioned. 1 of 4 rows cannot be acted on.',
    }
    render(<SlotPanel {...props} csv="x" plan={plan} />)

    expect(screen.queryByRole('button', { name: /Provision/ })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing was provisioned/)
    expect(screen.getByText(/No room called "Hall Z"/)).toBeInTheDocument()
  })

  it('offers no provisioning controls at all below organiser', () => {
    render(<SlotPanel {...props} onProvision={undefined} />)
    expect(screen.queryByLabelText('Slots')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check the file' })).not.toBeInTheDocument()
    // The pool still reads.
    expect(screen.getByTestId('slots-available')).toBeInTheDocument()
  })
})
