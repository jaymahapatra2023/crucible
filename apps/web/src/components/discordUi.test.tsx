/**
 * Discord on the screens (E49): the registration field, the delivery channel, the People tab.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiscordField } from './DiscordField.js'
import { DeliveryPanel } from './DeliveryPanel.js'
import { ParticipantRow } from './ParticipantRow.js'
import type { TeamDelivery } from '../lib/intakeApi.js'
import type { Participant } from '../lib/rosterApi.js'

describe('the registration field', () => {
  it('renders nothing when Discord is not configured — nobody is asked for what cannot be used', () => {
    const { container } = render(<DiscordField enabled={false} inviteUrl="" value="" busy={false}
      onChange={vi.fn()} onCheck={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('confirms a found username by display name', async () => {
    const onCheck = vi.fn(async () => ({ found: true, displayName: 'Ada', message: 'Found.' }))
    render(<DiscordField enabled inviteUrl="" value="ada_dev" busy={false} onChange={vi.fn()} onCheck={onCheck} />)
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(onCheck).toHaveBeenCalledWith('ada_dev')
    expect(await screen.findByRole('status')).toHaveTextContent('Found: Ada')
  })

  it('says to join the server, with the invite, when not found', async () => {
    const onCheck = vi.fn(async () => ({ found: false, displayName: null, message: 'No member of the event server has that username. Join the event server first: https://discord.gg/x' }))
    render(<DiscordField enabled inviteUrl="https://discord.gg/x" value="nobody" busy={false} onChange={vi.fn()} onCheck={onCheck} />)
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Join the event server first/)
  })
})

describe('the delivery channel', () => {
  const team = (over: Partial<TeamDelivery> = {}): TeamDelivery => ({
    teamId: 1, teamName: 'Alpha', contactEmail: 'a@t.test', status: 'SENT', attempts: 1,
    lastError: null, providerRef: 'x', channel: 'email', hasDiscord: false, preparedAt: null, ...over,
  })
  const panel = (rows: TeamDelivery[]) => render(
    <DeliveryPanel state={rows} report={null} busy={false} onPrepare={vi.fn()} onDownload={vi.fn()} />)

  it('says a Discord contact reached by email is a refused DM', () => {
    panel([team({ status: 'FAILED', channel: 'email', hasDiscord: true, lastError: 'Discord refused: closed DMs' })])
    expect(screen.getByRole('row', { name: /Alpha/ })).toHaveTextContent(/Email \(Discord refused\)/)
  })

  it('says Discord DM when that is what carried it', () => {
    panel([team({ status: 'FAILED', channel: 'discord', hasDiscord: true })])
    expect(screen.getByRole('row', { name: /Alpha/ })).toHaveTextContent('Discord DM')
  })

  it('says what WILL be tried before anything was attempted', () => {
    panel([team({ status: 'NONE', channel: null, hasDiscord: true })])
    expect(screen.getByRole('row', { name: /Alpha/ })).toHaveTextContent('Discord and email')
  })

  it('states BOTH plainly, with nothing to act on, when both channels carried it', () => {
    // The ordinary outcome under migration 100. Marking it would train organisers to ignore
    // the marks that matter.
    panel([team({ status: 'SENT', channel: 'both', hasDiscord: true })])
    const sent = screen.getByRole('listitem')
    expect(sent).toHaveTextContent('Discord DM and email')
    expect(sent).not.toHaveTextContent('refused')
  })

  it('names the channel for a team that WAS reached, so a refused DM is still visible', () => {
    // The case that only exists once both channels are attempted: the team has the code, the
    // DM was refused, and the row is not in the outstanding table because nothing is wrong
    // from the team's side. It must still be findable.
    panel([team({ status: 'SENT', channel: 'email', hasDiscord: true })])
    expect(screen.getByRole('listitem')).toHaveTextContent(/Email \(Discord refused\)/)
  })

  it('says email did not go when DISCORD alone carried it', () => {
    // A partial delivery an organiser must see: the team has the code, the relay is broken, and
    // the next forty teams are about to hit the same relay.
    panel([team({ status: 'SENT', channel: 'discord', hasDiscord: true })])
    expect(screen.getByRole('listitem')).toHaveTextContent('email did not go')
  })
})

describe('the People tab', () => {
  const person = (over: Partial<Participant> = {}): Participant => ({
    participantId: 1, fullName: 'Ada Lovelace', email: 'ada@example.test', organisation: null,
    phone: null, notes: '', discordUsername: null, discordUserId: null, ...over,
  })
  const row = (p: Participant) => render(
    <table><tbody><ParticipantRow person={p} busy={false} onSave={vi.fn()} onRemove={vi.fn()} /></tbody></table>)

  it('marks a username the bot could not find, because that team cannot be DMed', () => {
    row(person({ discordUsername: 'ada_dev', discordUserId: null }))
    expect(screen.getByRole('row')).toHaveTextContent('ada_dev (not found in server)')
  })

  it('shows a resolved username plainly', () => {
    row(person({ discordUsername: 'ada_dev', discordUserId: '111111111111111111' }))
    expect(screen.getByRole('row')).toHaveTextContent('ada_dev')
    expect(screen.getByRole('row')).not.toHaveTextContent(/not found/)
  })

  it('sends the username with a correction', async () => {
    const onSave = vi.fn()
    render(<table><tbody><ParticipantRow person={person()} busy={false} onSave={onSave} onRemove={vi.fn()} /></tbody></table>)
    await userEvent.click(screen.getByRole('button', { name: /Edit/ }))
    await userEvent.type(screen.getByLabelText('Discord username'), 'ada_dev')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ discordUsername: 'ada_dev' }))
  })
})
