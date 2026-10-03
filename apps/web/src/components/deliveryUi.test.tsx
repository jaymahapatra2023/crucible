/**
 * Whether each team actually got its code (E34).
 *
 * The gap being closed is silent: a team that never received its code does not complain, it just
 * fails to enter. So the tests are about the failures being the loud part.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeliveryPanel } from './DeliveryPanel.js'
import type { DeliveryReport, TeamDelivery } from '../lib/intakeApi.js'

const team = (over: Partial<TeamDelivery> = {}): TeamDelivery => ({
  teamId: 1, teamName: 'Alpha', contactEmail: 'alpha@example.test',
  status: 'NONE', attempts: 0, lastError: null, providerRef: null, channel: null, hasDiscord: false,
  preparedAt: null, ...over,
})

const props = { report: null, busy: false, onPrepare: vi.fn(), onDownload: vi.fn() }

describe('the number that says whether the job is done', () => {
  it('counts the teams NOT reached, not the messages sent', () => {
    render(<DeliveryPanel {...props} state={[
      team({ teamId: 1, status: 'SENT' }),
      team({ teamId: 2, teamName: 'Beta', status: 'NONE' }),
      team({ teamId: 3, teamName: 'Gamma', status: 'FAILED' }),
    ]} />)

    expect(screen.getByTestId('unreached-count')).toHaveTextContent('2')
    expect(screen.getByText(/of 3 teams have not been sent a code/)).toBeInTheDocument()
  })

  it('distinguishes "not attempted" from "failed", which have different fixes', () => {
    render(<DeliveryPanel {...props} state={[
      team({ teamId: 2, teamName: 'Beta', status: 'NONE' }),
      team({ teamId: 3, teamName: 'Gamma', status: 'FAILED', lastError: 'no contact address' }),
    ]} />)

    expect(screen.getByRole('row', { name: /Beta/ })).toHaveTextContent('Not attempted')
    expect(screen.getByRole('row', { name: /Gamma/ })).toHaveTextContent('FAILED')
    expect(screen.getByRole('row', { name: /Gamma/ })).toHaveTextContent('no contact address')
  })

  it('names a team with no address as having none, rather than showing an empty cell', () => {
    render(<DeliveryPanel {...props} state={[team({ contactEmail: '', status: 'FAILED' })]} />)
    expect(screen.getByText('no address')).toBeInTheDocument()
  })

  it('leaves a reached team off the worklist', () => {
    render(<DeliveryPanel {...props} state={[team({ status: 'SENT' })]} />)
    expect(screen.getByTestId('unreached-count')).toHaveTextContent('0')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

const report = (over: Partial<DeliveryReport> = {}): DeliveryReport => ({
  provider: 'record', sends: false,
  outcomes: [{ teamId: 1, teamName: 'Alpha', status: 'PREPARED', detail: 'Composed.' }],
  messages: [{ teamName: 'Alpha', to: 'alpha@example.test', subject: 's', body: 'b' }],
  ...over,
})

describe('after an issue', () => {
  it('says plainly that nothing was sent when no provider is configured', () => {
    render(<DeliveryPanel {...props} state={[team()]} report={report()} />)
    expect(screen.getByText(/No mail provider is configured, so nothing was sent/))
      .toBeInTheDocument()
  })

  it('warns that the messages exist only on this screen, and cannot be reproduced', async () => {
    const onDownload = vi.fn()
    const user = userEvent.setup()
    render(<DeliveryPanel {...props} state={[team()]} report={report()} onDownload={onDownload} />)

    expect(screen.getByText(/exist only on this screen/)).toBeInTheDocument()
    expect(screen.getByText(/cannot be produced again/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Download the 1 message/ }))
    expect(onDownload).toHaveBeenCalled()
  })

  it('offers no download when a real provider sent them', () => {
    render(<DeliveryPanel {...props} state={[team({ status: 'SENT' })]}
      report={report({ provider: 'resend', sends: true, messages: [] })} />)

    expect(screen.getByText(/Sent through resend/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument()
  })

  it('names each team that could not be prepared', () => {
    render(<DeliveryPanel {...props} state={[team()]} report={report({
      outcomes: [
        { teamId: 1, teamName: 'Alpha', status: 'PREPARED', detail: 'Composed.' },
        { teamId: 2, teamName: 'Beta', status: 'FAILED', detail: 'No contact address.' },
      ],
    })} />)

    expect(screen.getByText(/1 could not be prepared/)).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })
})


describe('answering "did it go?" (E43)', () => {
  it('lists reached teams with the provider reference, collapsed so the unreached stay primary', async () => {
    const user = userEvent.setup()
    render(<DeliveryPanel {...props} state={[
      team({ teamId: 1, status: 'SENT', providerRef: 'msg_abc' }),
      team({ teamId: 2, teamName: 'Beta', status: 'NONE' }),
    ]} />)

    // Collapsed by default: the count of NOT reached is the number that says whether it is done.
    const summary = screen.getByText('1 sent or prepared')
    expect(screen.getByTestId('unreached-count')).toHaveTextContent('1')

    await user.click(summary)
    const sent = screen.getByRole('list', { name: 'Teams sent a code' })
    expect(sent).toHaveTextContent('Alpha · SENT')
    expect(sent).toHaveTextContent('msg_abc')
  })

  it('shows no reference for a prepared message, which the provider never saw', async () => {
    const user = userEvent.setup()
    render(<DeliveryPanel {...props} state={[team({ status: 'PREPARED' })]} />)
    await user.click(screen.getByText('1 sent or prepared'))
    expect(screen.getByRole('list', { name: 'Teams sent a code' })).not.toHaveTextContent('ref')
  })
})
