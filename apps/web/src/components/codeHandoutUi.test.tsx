/**
 * The one-time code handout on screen (migration 103).
 *
 * What matters: the waiting count is the primary signal, a blocked team is named in words with
 * the reason, and the send button is absent below organiser rather than present and refusing.
 *
 * And — added after the first real send reached thirty registrants instead of a hundred and
 * sixteen team members — that the panel reports PEOPLE, and names any team whose code would
 * reach one inbox. "30 teams" read as success. It was not.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodeHandoutPanel } from './CodeHandoutPanel.js'
import type { HandoutPlan } from '../lib/codeHandoutApi.js'

const plan = (over: Partial<HandoutPlan> = {}): HandoutPlan => ({
  rows: [],
  summary: { total: 0, waiting: 0, alreadySent: 0, blocked: 0 },
  report: null,
  ...over,
})

const props = { busy: false, canSend: true, onCheck: vi.fn(), onSend: vi.fn() }

describe('the code handout panel', () => {
  it('says what it is for, and that pressing twice is safe', () => {
    render(<CodeHandoutPanel {...props} plan={null} />)
    expect(screen.getByText(/not sent it again/i)).toBeInTheDocument()
    // Nothing to send until it has been checked.
    expect(screen.queryByRole('button', { name: /Send to/ })).not.toBeInTheDocument()
  })

  it('leads with how many teams are waiting', () => {
    render(<CodeHandoutPanel {...props} plan={plan({
      summary: { total: 48, waiting: 46, alreadySent: 2, blocked: 0 },
    })} />)
    expect(screen.getByTestId('handout-waiting')).toHaveTextContent('46')
    expect(screen.getByText(/of 48 registered teams/)).toBeInTheDocument()
    expect(screen.getByText(/2 already have/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to 46 teams' })).toBeEnabled()
  })

  it('names each team that cannot be sent one, with the reason', () => {
    render(<CodeHandoutPanel {...props} plan={plan({
      summary: { total: 2, waiting: 1, alreadySent: 0, blocked: 1 },
      rows: [{
        teamId: 7, teamName: 'Night Shift', contactEmail: '', copiedTo: 0, state: 'BLOCKED',
        detail: 'No contact address on this team, so there is nowhere to send it.',
      }],
    })} />)
    const list = screen.getByRole('list', { name: 'Teams that cannot be sent a code' })
    expect(list).toHaveTextContent('Night Shift')
    expect(list).toHaveTextContent('nowhere to send it')
  })

  it('disables the send button when nothing is waiting, and says so', () => {
    render(<CodeHandoutPanel {...props} plan={plan({
      summary: { total: 48, waiting: 0, alreadySent: 48, blocked: 0 },
    })} />)
    expect(screen.getByRole('button', { name: 'Nothing waiting' })).toBeDisabled()
  })

  it('offers no send button at all below organiser', () => {
    render(<CodeHandoutPanel {...props} canSend={false} plan={plan({
      summary: { total: 48, waiting: 46, alreadySent: 2, blocked: 0 },
    })} />)
    expect(screen.getByTestId('handout-waiting')).toHaveTextContent('46')
    expect(screen.queryByRole('button', { name: /Send to/ })).not.toBeInTheDocument()
  })

  it('checks before it sends', async () => {
    const onCheck = vi.fn()
    const user = userEvent.setup()
    render(<CodeHandoutPanel {...props} onCheck={onCheck} plan={null} />)
    await user.click(screen.getByRole('button', { name: 'Check who is waiting' }))
    expect(onCheck).toHaveBeenCalledOnce()
  })

  it('says plainly when the adapter composed but transmitted nothing', () => {
    render(<CodeHandoutPanel {...props} plan={plan({
      summary: { total: 1, waiting: 0, alreadySent: 1, blocked: 0 },
      report: { provider: 'record', sends: false, outcomes: [], messages: [] },
    })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/nothing left this machine/)
  })

  it('reports PEOPLE as well as teams — the count that was wrong the first time', () => {
    render(<CodeHandoutPanel {...props} plan={plan({
      summary: { total: 2, waiting: 2, alreadySent: 0, blocked: 0 },
      rows: [
        { teamId: 1, teamName: 'Ada', contactEmail: 'a@x.test', copiedTo: 3, state: 'WAITING', detail: null },
        { teamId: 2, teamName: 'Bell', contactEmail: 'b@x.test', copiedTo: 2, state: 'WAITING', detail: null },
      ],
    })} />)
    // 2 registrants + 5 teammates. A panel that only said "2 teams" is what hid the problem.
    expect(screen.getByTestId('handout-people')).toHaveTextContent('7 people')
    expect(screen.getByRole('button', { name: 'Send to 2 teams · 7 people' })).toBeEnabled()
  })

  it('NAMES a team whose code would reach only one person', () => {
    render(<CodeHandoutPanel {...props} plan={plan({
      summary: { total: 2, waiting: 2, alreadySent: 0, blocked: 0 },
      rows: [
        { teamId: 1, teamName: 'Ada', contactEmail: 'a@x.test', copiedTo: 3, state: 'WAITING', detail: null },
        { teamId: 2, teamName: 'Solo', contactEmail: 'b@x.test', copiedTo: 0, state: 'WAITING', detail: null },
      ],
    })} />)
    const list = screen.getByRole('list', { name: 'Teams where the code reaches only one person' })
    expect(list).toHaveTextContent('Solo')
    expect(list).not.toHaveTextContent('Ada')
  })

  it('does not offer a re-send below organiser', () => {
    render(<CodeHandoutPanel {...props} canSend={false} plan={null} />)
    expect(screen.queryByLabelText(/Send again to teams already sent/)).not.toBeInTheDocument()
  })

  it('passes the re-send choice through to both the check and the send', async () => {
    const onCheck = vi.fn()
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<CodeHandoutPanel
      {...props} onCheck={onCheck} onSend={onSend}
      plan={plan({
        summary: { total: 1, waiting: 1, alreadySent: 0, blocked: 0 },
        rows: [{ teamId: 1, teamName: 'Ada', contactEmail: 'a@x.test', copiedTo: 3, state: 'WAITING', detail: null }],
      })}
    />)
    // Off by default: the ordinary press must not re-mail a code to a hundred people.
    await user.click(screen.getByRole('button', { name: 'Check who is waiting' }))
    expect(onCheck).toHaveBeenLastCalledWith(false)

    await user.click(screen.getByLabelText(/Send again to teams already sent/))
    await user.click(screen.getByRole('button', { name: /^Send to 1 team/ }))
    expect(onSend).toHaveBeenLastCalledWith(true)
  })
})
