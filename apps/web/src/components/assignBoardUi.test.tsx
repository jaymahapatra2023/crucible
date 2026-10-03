/**
 * Putting 200 people on teams (E28-S02).
 *
 * The tests are about the three decisions the volume forced: keyboard over mouse, the unassigned
 * count as the primary signal, and undo without a confirmation. A test suite that only checked
 * that buttons render would not have caught any of them being wrong.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssignBoard } from './AssignBoard.js'
import type { RosterBoard, TeamMember, TeamOnBoard } from '../lib/rosterApi.js'

const person = (id: number, name: string, email = `p${id}@example.test`) => ({
  participantId: id, fullName: name, email, organisation: null, phone: null, notes: '',
  discordUsername: null, discordUserId: null,
})

const member = (id: number, name: string, over: Partial<TeamMember> = {}): TeamMember => ({
  memberId: id, teamId: 1, participantId: id, fullName: name,
  email: `p${id}@example.test`, organisation: null, isContact: false, ...over,
})

const team = (over: Partial<TeamOnBoard> = {}): TeamOnBoard => ({
  teamId: 1, displayName: 'Alpha', contactEmail: 'alpha@example.test',
  members: [], roomLabel: null, coachName: null, ...over,
})

const board = (over: Partial<RosterBoard> = {}): RosterBoard => ({
  unassigned: [person(10, 'Ada Lovelace'), person(11, 'Grace Hopper')],
  unassignedTotal: 2,
  participantTotal: 2,
  teams: [team()],
  ...over,
})

const props = {
  busy: false, undoable: null,
  onAssign: vi.fn(), onUnassign: vi.fn(), onSetContact: vi.fn(), onUndo: vi.fn(),
  onCreateTeam: vi.fn(),
}

describe('the number that says whether it is done', () => {
  it('shows the REAL unassigned total, not the length of the list', async () => {
    // At 200 participants the list is bounded and the count is not. Showing the list length
    // would say the job was finished when it was one page in (P5.7).
    render(<AssignBoard {...props} board={board({
      unassigned: [person(10, 'Ada Lovelace')], unassignedTotal: 137, participantTotal: 200,
    })} />)

    expect(screen.getByTestId('unassigned-count')).toHaveTextContent('137')
    expect(screen.getByText(/of 200 still to assign/)).toBeInTheDocument()
  })

  it('says the list is bounded when it is, rather than paginating silently', () => {
    render(<AssignBoard {...props} board={board({
      unassigned: [person(10, 'Ada Lovelace')], unassignedTotal: 137, participantTotal: 200,
    })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Showing 1 of 137/)
  })

  it('says everybody is on a team when nobody is left', () => {
    render(<AssignBoard {...props} board={board({
      unassigned: [], unassignedTotal: 0, participantTotal: 4,
    })} />)
    expect(screen.getByText(/Everybody is on a team/)).toBeInTheDocument()
  })
})

describe('keyboard over mouse', () => {
  it('assigns the first match on Enter, without touching a button', async () => {
    const onAssign = vi.fn()
    render(<AssignBoard {...props} onAssign={onAssign} board={board()} />)

    await userEvent.type(screen.getByLabelText('Find a participant'), 'grace{enter}')
    expect(onAssign).toHaveBeenCalledWith(1, 11)
  })

  it('clears the box and keeps focus, so the next name can be typed straight away', async () => {
    render(<AssignBoard {...props} board={board()} />)
    const box = screen.getByLabelText('Find a participant')

    await userEvent.type(box, 'ada{enter}')
    expect(box).toHaveValue('')
    expect(box).toHaveFocus()
  })

  it('searches the address as well as the name', async () => {
    const onAssign = vi.fn()
    render(<AssignBoard {...props} onAssign={onAssign} board={board({
      unassigned: [person(10, 'Ada Lovelace', 'countess@example.test')], unassignedTotal: 1,
      participantTotal: 1,
    })} />)

    await userEvent.type(screen.getByLabelText('Find a participant'), 'countess{enter}')
    expect(onAssign).toHaveBeenCalledWith(1, 10)
  })

  it('does nothing on Enter when nothing matches', async () => {
    const onAssign = vi.fn()
    render(<AssignBoard {...props} onAssign={onAssign} board={board()} />)
    await userEvent.type(screen.getByLabelText('Find a participant'), 'zzzz{enter}')
    expect(onAssign).not.toHaveBeenCalled()
  })

  it('says which team Enter would assign to, so the keystroke is not a guess', () => {
    render(<AssignBoard {...props} board={board({ teams: [team({ displayName: 'Night Shift' })] })} />)
    expect(screen.getByText(/press Enter to put the first match on/)).toBeInTheDocument()
    expect(screen.getByText('Night Shift', { selector: 'strong' })).toBeInTheDocument()
  })

  it('cannot assign with no team selected', () => {
    render(<AssignBoard {...props} board={board({ teams: [] })} />)
    expect(screen.getByLabelText('Find a participant')).toBeDisabled()
  })
})

describe('the selected team is sticky', () => {
  it('keeps the team chosen across assignments, so it is picked once not per person', async () => {
    // An operator fills one team then moves on. Re-picking per person would double the work.
    const onAssign = vi.fn()
    render(<AssignBoard {...props} onAssign={onAssign} board={board({
      teams: [team(), team({ teamId: 2, displayName: 'Beta' })],
    })} />)

    await userEvent.click(screen.getByRole('button', { name: /Beta/ }))
    await userEvent.type(screen.getByLabelText('Find a participant'), 'ada{enter}')
    await userEvent.type(screen.getByLabelText('Find a participant'), 'grace{enter}')

    expect(onAssign).toHaveBeenNthCalledWith(1, 2, 10)
    expect(onAssign).toHaveBeenNthCalledWith(2, 2, 11)
  })

  it('shows the roster of the selected team only', async () => {
    render(<AssignBoard {...props} board={board({
      teams: [
        team({ members: [member(10, 'Ada Lovelace')] }),
        team({ teamId: 2, displayName: 'Beta', members: [member(11, 'Grace Hopper', { teamId: 2 })] }),
      ],
    })} />)

    const teams = screen.getByRole('list', { name: 'Teams' })
    expect(within(teams).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(teams).queryByText('Grace Hopper')).not.toBeInTheDocument()
  })

  it('shows where a team sits and who coaches it, since that is what is usually being checked', () => {
    render(<AssignBoard {...props} board={board({
      teams: [team({ roomLabel: 'Ada Room', coachName: 'Margaret Hamilton' })],
    })} />)
    const teams = screen.getByRole('list', { name: 'Teams' })
    expect(teams).toHaveTextContent('Ada Room')
    expect(teams).toHaveTextContent('Margaret Hamilton')
  })

  it('shows a team with nobody on it rather than hiding it', () => {
    // An empty team is the commonest thing an operator is looking for.
    render(<AssignBoard {...props} board={board({ teams: [team({ displayName: 'Nobody Yet' })] })} />)
    expect(screen.getByRole('button', { name: /Nobody Yet/ })).toBeInTheDocument()
  })
})

describe('undo', () => {
  it('is offered with what it would undo, named', async () => {
    const onUndo = vi.fn()
    render(<AssignBoard {...props} onUndo={onUndo} undoable="Ada Lovelace → Alpha"
      board={board()} />)

    const button = screen.getByRole('button', { name: /Undo — Ada Lovelace → Alpha/ })
    await userEvent.click(button)
    expect(onUndo).toHaveBeenCalledOnce()
  })

  it('is absent when there is nothing to undo', () => {
    render(<AssignBoard {...props} board={board()} />)
    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument()
  })

  it('asks for no confirmation — a dialogue costs more than the mistake', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const onUndo = vi.fn()
    render(<AssignBoard {...props} onUndo={onUndo} undoable="Ada → Alpha" board={board()} />)

    await userEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(confirm).not.toHaveBeenCalled()
    expect(onUndo).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})

describe('correcting a team', () => {
  it('takes somebody off, and offers no confirmation for that either', async () => {
    const onUnassign = vi.fn()
    render(<AssignBoard {...props} onUnassign={onUnassign} board={board({
      teams: [team({ members: [member(10, 'Ada Lovelace')] })],
    })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onUnassign).toHaveBeenCalledWith(10)
  })

  it('names a point of contact, and does not offer to re-name the one who holds it', async () => {
    const onSetContact = vi.fn()
    render(<AssignBoard {...props} onSetContact={onSetContact} board={board({
      teams: [team({ members: [
        member(10, 'Ada Lovelace', { isContact: true }),
        member(11, 'Grace Hopper'),
      ] })],
    })} />)

    expect(screen.getByText(/point of contact/)).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Make contact' })
    expect(buttons).toHaveLength(1)

    await userEvent.click(buttons[0]!)
    expect(onSetContact).toHaveBeenCalledWith(1, 11)
  })

  it('disables the buttons while something is in flight, but NOT the search box', async () => {
    // Disabling the focused element blurs it, which broke the whole fast path: type, Enter,
    // type — the second name went nowhere. Keeping it live also lets an operator type ahead of
    // the network, which at two hundred people is the difference that matters.
    const onAssign = vi.fn()
    render(<AssignBoard {...props} busy onAssign={onAssign} board={board({
      teams: [team({ members: [member(10, 'Ada Lovelace')] })],
    })} />)

    expect(screen.getByLabelText('Find a participant')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()

    // And Enter still assigns: assignments are independent of each other, so a keystroke
    // arriving during a save is acted on rather than dropped.
    await userEvent.type(screen.getByLabelText('Find a participant'), 'ada{enter}')
    expect(onAssign).toHaveBeenCalledOnce()
  })
})

describe('creating a team without leaving the screen (acceptance 7)', () => {
  it('offers the person currently at the top of the search as the first member', async () => {
    const user = userEvent.setup()
    render(<AssignBoard {...props} board={board()} />)

    // Nothing searched yet: there is nobody to take along, so nobody is offered.
    expect(screen.queryByText(/as its first member/)).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/Find a participant/), 'Grace')
    expect(screen.getByText(/Grace Hopper/, { selector: 'strong' })).toBeInTheDocument()
  })

  it('creates with that person, because that is why the team is being made', async () => {
    const onCreateTeam = vi.fn()
    const user = userEvent.setup()
    render(<AssignBoard {...props} onCreateTeam={onCreateTeam} board={board()} />)

    await user.type(screen.getByLabelText(/Find a participant/), 'Grace')
    await user.type(screen.getByLabelText(/Create a team/), 'Night Shift')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreateTeam).toHaveBeenCalledWith('Night Shift', 11)
  })

  it('creates an empty team when the offer is declined, and says it has no address', async () => {
    const onCreateTeam = vi.fn()
    const user = userEvent.setup()
    render(<AssignBoard {...props} onCreateTeam={onCreateTeam} board={board()} />)

    await user.type(screen.getByLabelText(/Find a participant/), 'Grace')
    await user.type(screen.getByLabelText(/Create a team/), 'Night Shift')
    await user.click(screen.getByRole('checkbox'))

    // Stated before the act, not discovered afterwards (P5.1).
    expect(screen.getByRole('status'))
      .toHaveTextContent(/Night Shift will have nobody on it and no contact address/)

    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreateTeam).toHaveBeenCalledWith('Night Shift', null)
  })

  it('will not create a team from a name too short to be one', async () => {
    const onCreateTeam = vi.fn()
    const user = userEvent.setup()
    render(<AssignBoard {...props} onCreateTeam={onCreateTeam} board={board()} />)

    await user.type(screen.getByLabelText(/Create a team/), 'X')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(onCreateTeam).not.toHaveBeenCalled()
  })

  it('selects the new team once it arrives, so the next Enter does not go to the old one', async () => {
    // The silent misassignment this guards against: create "Beta", press Enter, and the person
    // lands on "Alpha" because the selection never moved.
    const onAssign = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <AssignBoard {...props} onAssign={onAssign} board={board()} />)

    await user.type(screen.getByLabelText(/Create a team/), 'Beta')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    // The board comes back from the server with Beta on it.
    rerender(<AssignBoard {...props} onAssign={onAssign} board={board({
      teams: [team(), team({ teamId: 2, displayName: 'Beta' })],
    })} />)

    await user.type(screen.getByLabelText(/Find a participant/), 'Ada')
    await user.keyboard('{Enter}')
    expect(onAssign).toHaveBeenCalledWith(2, 10)
  })

  it('tells an operator with no teams that one can be made here', () => {
    render(<AssignBoard {...props} board={board({ teams: [] })} />)
    expect(screen.getByText(/Make one above/)).toBeInTheDocument()
  })
})
