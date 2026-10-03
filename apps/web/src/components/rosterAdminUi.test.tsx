/**
 * The roster surfaces an organiser actually works in (E31).
 *
 * What is tested is the behaviour these panels exist for: adding one person without a file,
 * correcting a record in place, removing somebody only with a reason, and seeing that a room is
 * already taken rather than finding it missing from the list.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PeoplePanel } from './PeoplePanel.js'
import { VenuePanel } from './VenuePanel.js'
import { LogisticsPanel } from './LogisticsPanel.js'
import type { Coach, Participant, Room, TeamLogistics, TeamOnBoard } from '../lib/rosterApi.js'

const person = (id: number, fullName: string, over: Partial<Participant> = {}): Participant => ({
  participantId: id, fullName, email: `p${id}@example.test`,
  organisation: null, phone: null, notes: '', discordUsername: null, discordUserId: null, ...over,
})

const peopleProps = {
  people: [person(1, 'Ada Lovelace'), person(2, 'Grace Hopper', { organisation: 'Navy' })],
  total: 2, busy: false, query: {}, onQuery: vi.fn(),
  onAdd: vi.fn(), onSave: vi.fn(), onRemove: vi.fn(),
}

describe('adding and correcting a participant', () => {
  it('adds one without a file, and keeps the form open for the next', async () => {
    const onAdd = vi.fn()
    const user = userEvent.setup()
    render(<PeoplePanel {...peopleProps} onAdd={onAdd} />)

    await user.type(screen.getByLabelText('Full name'), 'Alan Turing')
    await user.type(screen.getByLabelText('Email'), 'alan@example.test')
    await user.click(screen.getByRole('button', { name: 'Add participant' }))

    expect(onAdd).toHaveBeenCalledWith({
      fullName: 'Alan Turing', email: 'alan@example.test', organisation: null, discordUsername: null,
    })
    // Cleared but still there: adding one person is usually adding three.
    expect(screen.getByLabelText('Full name')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Add participant' })).toBeInTheDocument()
  })

  it('will not add somebody without a usable address', async () => {
    const user = userEvent.setup()
    render(<PeoplePanel {...peopleProps} />)

    await user.type(screen.getByLabelText('Full name'), 'Alan Turing')
    await user.type(screen.getByLabelText('Email'), 'not-an-address')
    expect(screen.getByRole('button', { name: 'Add participant' })).toBeDisabled()
  })

  it('corrects a record in place, sending only what changed', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<PeoplePanel {...peopleProps} onSave={onSave} />)

    const row = screen.getByRole('row', { name: /Ada Lovelace/ })
    await user.click(within(row).getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit Ada Lovelace' })
    const name = within(form).getByLabelText('Full name')
    await user.clear(name)
    await user.type(name, 'Ada Byron')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).toHaveBeenCalledWith(1, expect.objectContaining({ fullName: 'Ada Byron' }))
  })

  it('will not remove anybody until a reason is chosen (P7.4)', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(<PeoplePanel {...peopleProps} onRemove={onRemove} />)

    const row = screen.getByRole('row', { name: /Ada Lovelace/ })
    await user.click(within(row).getByRole('button', { name: 'Remove' }))
    // The reason IS the confirmation; nothing has gone yet.
    expect(onRemove).not.toHaveBeenCalled()

    await user.selectOptions(
      screen.getByLabelText(/Why Ada Lovelace is being removed/), 'DEDUP')
    expect(onRemove).toHaveBeenCalledWith(1, 'DEDUP')
  })

  it('shows the real roster total beside a bounded page (P5.7)', () => {
    render(<PeoplePanel {...peopleProps} people={[person(1, 'Ada Lovelace')]} total={200} />)
    expect(screen.getByTestId('pager')).toHaveTextContent('1–1 of 200')
  })

  it('SEARCHES ON THE SERVER, not within the page it was given', async () => {
    // At 200 participants across pages, filtering the rows in hand searches a quarter of the
    // roster and reports confidently that nobody matches.
    const onQuery = vi.fn()
    const user = userEvent.setup()
    render(<PeoplePanel {...peopleProps} onQuery={onQuery} />)

    await user.type(screen.getByLabelText('Search participants'), 'a')
    expect(onQuery).toHaveBeenCalledWith({ search: 'a', page: 1 })
  })
})

const room = (id: number, label: string, over: Partial<Room> = {}): Room => ({
  roomId: id, label, location: 'First floor', capacity: 6, teamCapacity: 1, inUse: true, ...over,
})

const coach = (id: number, fullName: string, over: Partial<Coach> = {}): Coach => ({
  coachId: id, fullName, email: `c${id}@example.test`, organisation: null,
  teamCapacity: 1, active: true, ...over,
})

describe('rooms and coaches', () => {
  const venueProps = {
    rooms: [room(1, 'Ada')], coaches: [coach(1, 'Margaret Hamilton')], busy: false,
    onAddRoom: vi.fn(), onSaveRoom: vi.fn(), onAddCoach: vi.fn(), onSaveCoach: vi.fn(),
  }

  it('takes a room out of use rather than deleting it', async () => {
    const onSaveRoom = vi.fn()
    const user = userEvent.setup()
    render(<VenuePanel {...venueProps} onSaveRoom={onSaveRoom} />)

    // There is no delete control at all — a room used yesterday still has to exist.
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Ada in use' }))
    expect(onSaveRoom).toHaveBeenCalledWith(1, { inUse: false })
  })

  it('writes the state out, never leaving it to the checkbox alone (P5.4)', () => {
    render(<VenuePanel {...venueProps} rooms={[room(1, 'Ada', { inUse: false })]} />)
    expect(screen.getByText('Out of use')).toBeInTheDocument()
  })

  it('adds a coach, and says a coach is never on a team', async () => {
    const onAddCoach = vi.fn()
    const user = userEvent.setup()
    render(<VenuePanel {...venueProps} onAddCoach={onAddCoach} />)

    expect(screen.getByText(/never a member of a team/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Coach name'), 'Katherine Johnson')
    await user.type(screen.getByLabelText('Coach email'), 'kj@example.test')
    await user.click(screen.getByRole('button', { name: 'Add coach' }))

    expect(onAddCoach).toHaveBeenCalledWith({
      fullName: 'Katherine Johnson', email: 'kj@example.test', organisation: null,
      // Null, not one: nobody was asked how many teams they would take (migration 102).
      teamCapacity: null,
    })
  })

  it('sends the number of teams a coach agreed to take', async () => {
    const onAddCoach = vi.fn()
    const user = userEvent.setup()
    render(<VenuePanel {...venueProps} onAddCoach={onAddCoach} />)

    await user.type(screen.getByLabelText('Coach name'), 'Josh Humpherys')
    await user.type(screen.getByLabelText('Coach email'), 'josh@example.test')
    await user.type(screen.getByLabelText('Coach team capacity'), '2')
    await user.click(screen.getByRole('button', { name: 'Add coach' }))

    expect(onAddCoach).toHaveBeenCalledWith(expect.objectContaining({ teamCapacity: 2 }))
  })

  it('sends BOTH room limits, which are different numbers', async () => {
    // The Dining Room seats 100 people and takes 12 teams; neither follows from the other.
    const onAddRoom = vi.fn()
    const user = userEvent.setup()
    render(<VenuePanel {...venueProps} onAddRoom={onAddRoom} />)

    await user.type(screen.getByLabelText('Room label'), 'Dining Room')
    await user.type(screen.getByLabelText('Room location'), 'Greene 3')
    await user.type(screen.getByLabelText('Room capacity'), '100')
    await user.type(screen.getByLabelText('Room team capacity'), '12')
    await user.click(screen.getByRole('button', { name: 'Add room' }))

    expect(onAddRoom).toHaveBeenCalledWith({
      label: 'Dining Room', location: 'Greene 3', capacity: 100, teamCapacity: 12,
    })
  })
})

const team = (id: number, displayName: string): TeamOnBoard => ({
  teamId: id, displayName, contactEmail: `${id}@example.test`,
  members: [], roomLabel: null, coachName: null,
})

const place = (teamId: number, over: Partial<TeamLogistics> = {}): TeamLogistics => ({
  teamId, roomId: null, roomLabel: null, roomLocation: null,
  coachId: null, coachName: null, coachEmail: null, ...over,
})

describe('giving a team a room and a coach', () => {
  const logisticsProps = {
    teams: [team(1, 'Alpha'), team(2, 'Beta')],
    logistics: [place(1, { roomId: 1, roomLabel: 'Ada' }), place(2)],
    rooms: [room(1, 'Ada'), room(2, 'Babbage')],
    coaches: [coach(1, 'Margaret Hamilton')],
    busy: false, onAssign: vi.fn(),
  }

  it('assigns a coach to a team', async () => {
    const onAssign = vi.fn()
    const user = userEvent.setup()
    render(<LogisticsPanel {...logisticsProps} onAssign={onAssign} />)

    await user.selectOptions(screen.getByLabelText('Coach for Beta'), '1')
    expect(onAssign).toHaveBeenCalledWith(2, { coachId: 1 })
  })

  it('shows a room already taken as taken, rather than hiding it', () => {
    render(<LogisticsPanel {...logisticsProps} />)
    // Ada is Alpha's. Beta must be able to see that it exists and who has it.
    const forBeta = screen.getByLabelText('Room for Beta')
    expect(within(forBeta).getByText(/Ada.*\(with Alpha\)/)).toBeInTheDocument()
  })

  it('does not offer a room that is out of use, but keeps the one a team already has', () => {
    render(<LogisticsPanel {...logisticsProps}
      rooms={[room(1, 'Ada', { inUse: false }), room(2, 'Babbage', { inUse: false })]} />)

    expect(within(screen.getByLabelText('Room for Alpha')).getByText(/Ada/)).toBeInTheDocument()
    expect(within(screen.getByLabelText('Room for Beta')).queryByText(/Babbage/)).toBeNull()
  })

  it('says how many teams still have nowhere to sit', () => {
    render(<LogisticsPanel {...logisticsProps} />)
    expect(screen.getByText(/1 of 2 without a room, 2 without a coach/)).toBeInTheDocument()
  })

  it('takes a room away when the empty option is chosen', async () => {
    const onAssign = vi.fn()
    const user = userEvent.setup()
    render(<LogisticsPanel {...logisticsProps} onAssign={onAssign} />)

    await user.selectOptions(screen.getByLabelText('Room for Alpha'), '')
    expect(onAssign).toHaveBeenCalledWith(1, { roomId: null })
  })
})
