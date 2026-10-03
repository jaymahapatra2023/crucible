/**
 * Building a team without a directory (E44-S04).
 *
 * It looks like selection and never is one. The tests are about what is NOT on the screen — a
 * list of participants — and about the count being the primary signal against the rule.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TeamBuilder, reasonsToWait, whereItGoes } from './TeamBuilder.js'
import type { LinkScope } from '../lib/registerApi.js'

const scope: LinkScope = {
  registrantName: 'Ada Lovelace', registrantEmail: 'ada@example.test',
  bounds: { min: 3, max: 8 }, expiresAt: '2026-10-03T12:00:00Z',
  discord: { enabled: false, inviteUrl: '' },
}

const found = (id: number, name: string) => async () => ({
  found: true, participantId: id, fullName: name, message: `${name} — added.`,
})

const props = {
  scope, busy: false, failure: null,
  onCheckName: vi.fn(async () => ({ ok: true, message: 'Available.' })),
  onLookup: vi.fn(found(2, 'Grace Hopper')),
  onConfirm: vi.fn(),
}

describe('the count is the primary signal', () => {
  it('starts at 1 of 3–8 — the registrant is already a member', () => {
    render(<TeamBuilder {...props} />)
    expect(screen.getByTestId('member-count')).toHaveTextContent('1')
    expect(screen.getByText(/of 3–8 members/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Team members' })).toHaveTextContent('Ada Lovelace')
  })

  it('is disabled WITH every reason stated, never enabled into a refusal', () => {
    render(<TeamBuilder {...props} />)
    expect(screen.getByRole('button', { name: 'Register the team' })).toBeDisabled()
    expect(screen.getByText(/To register: name the team, add 2 more teammates/))
      .toBeInTheDocument()
  })
})

describe('teammates arrive as chips, never as a list to pick from', () => {
  it('renders no participant list — only what was typed and confirmed', async () => {
    const user = userEvent.setup()
    render(<TeamBuilder {...props} />)

    // Nothing to select from at all. The challenge select used to be the single exception; it
    // moved to the submission form, where a team knows which path it took (E44-S04 / II.1).
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/Add a teammate by email/), 'grace@example.test{Enter}')
    await waitFor(() => expect(screen.getByRole('list', { name: 'Team members' }))
      .toHaveTextContent('Grace Hopper'))
    expect(props.onLookup).toHaveBeenCalledWith('grace@example.test')
    expect(screen.getByTestId('member-count')).toHaveTextContent('2')
  })

  it('says why an address was refused, inline', async () => {
    const user = userEvent.setup()
    render(<TeamBuilder {...props} onLookup={vi.fn(async () => ({
      found: false, message: 'No participant with that address. Check it with them.',
    }))} />)

    await user.type(screen.getByLabelText(/Add a teammate by email/), 'x@y.test{Enter}')
    await waitFor(() => expect(screen.getByRole('alert'))
      .toHaveTextContent(/No participant with that address/))
    expect(screen.getByTestId('member-count')).toHaveTextContent('1')
  })

  it('removes a chip, and the count follows', async () => {
    const user = userEvent.setup()
    render(<TeamBuilder {...props} />)
    await user.type(screen.getByLabelText(/Add a teammate by email/), 'grace@example.test{Enter}')
    await waitFor(() => expect(screen.getByTestId('member-count')).toHaveTextContent('2'))

    await user.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }))
    expect(screen.getByTestId('member-count')).toHaveTextContent('1')
  })
})

describe('confirming', () => {
  it('sends the plan whole once every reason is cleared', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    let next = 2
    render(<TeamBuilder {...props} onConfirm={onConfirm}
      onLookup={vi.fn(async (email: string) => {
        const id = next++
        return { found: true, participantId: id, fullName: email.split('@')[0]!, message: 'added' }
      })} />)

    await user.type(screen.getByLabelText(/^Team name/), 'Night Shift')
    await user.type(screen.getByLabelText(/Add a teammate by email/), 'grace@example.test{Enter}')
    await user.type(screen.getByLabelText(/Add a teammate by email/), 'alan@example.test{Enter}')
    await waitFor(() => expect(screen.getByTestId('member-count')).toHaveTextContent('3'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Register the team' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'Register the team' }))
    expect(onConfirm).toHaveBeenCalledWith({
      displayName: 'Night Shift', teammateIds: [2, 3], discordUsername: null,
      // Empty rather than absent: no teammate typed one, which is a different fact from the
      // form not having asked (migration 100).
      teammateDiscord: [],
    })
  })

  it('shows the live name collision as an inline error', async () => {
    const user = userEvent.setup()
    render(<TeamBuilder {...props} onCheckName={vi.fn(async () => ({
      ok: false, message: '"Night Shift" already exists.',
    }))} />)
    await user.type(screen.getByLabelText(/^Team name/), 'the night-shift')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/already exists/))
  })
})

describe('reasonsToWait — the rule, stated in the operator\'s order', () => {
  const bounds = { min: 3, max: 8 }
  const base = { displayName: 'Night Shift', nameCheck: { ok: true, message: '' }, bounds }

  it('is empty when everything is in place', () => {
    expect(reasonsToWait({ ...base, count: 3 })).toEqual([])
    expect(reasonsToWait({ ...base, count: 8 })).toEqual([])
  })

  it('counts how many are still needed, singular and plural', () => {
    expect(reasonsToWait({ ...base, count: 2 })).toEqual(['add 1 more teammate'])
    expect(reasonsToWait({ ...base, count: 1 })).toEqual(['add 2 more teammates'])
  })

  it('says how many to remove above the maximum', () => {
    expect(reasonsToWait({ ...base, count: 10 })).toEqual(['remove 2'])
  })

  it('no longer asks for a challenge — that is chosen at submission', () => {
    expect(reasonsToWait({ ...base, count: 3 })).toEqual([])
  })

  it('asks for a name before complaining it is taken', () => {
    expect(reasonsToWait({ ...base, displayName: '', count: 3 })).toEqual(['name the team'])
    expect(reasonsToWait({ ...base, nameCheck: { ok: false, message: 'taken' }, count: 3 }))
      .toEqual(['choose a name that is not taken'])
  })

  it('lists every outstanding reason at once', () => {
    expect(reasonsToWait({ displayName: '', nameCheck: null, count: 1, bounds }))
      .toEqual(['name the team', 'add 2 more teammates'])
  })
})

describe('a Discord username per member (migration 100)', () => {
  const withDiscord = {
    ...props,
    scope: { ...scope, discord: { enabled: true, inviteUrl: 'https://discord.gg/x' } },
    onCheckDiscord: vi.fn(async () => ({ found: true, displayName: 'Ada', message: 'Found.' })),
  }

  async function addGrace(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/Add a teammate by email/), 'grace@example.test')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    return screen.findByLabelText('Discord username for Grace Hopper')
  }

  it('offers a box for each teammate, not only for the registrant', async () => {
    const user = userEvent.setup()
    render(<TeamBuilder {...withDiscord} />)
    expect(await addGrace(user)).toBeInTheDocument()
  })

  it('offers NO teammate box when Discord is not configured — nobody is asked for the unusable', async () => {
    const user = userEvent.setup()
    render(<TeamBuilder {...props} />)
    await user.type(screen.getByLabelText(/Add a teammate by email/), 'grace@example.test')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Grace Hopper')
    expect(screen.queryByLabelText('Discord username for Grace Hopper')).not.toBeInTheDocument()
  })

  it('sends each teammate username with the plan, and omits the ones left blank', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onLookup = vi.fn()
      .mockImplementationOnce(found(2, 'Grace Hopper'))
      .mockImplementationOnce(found(3, 'Alan Turing'))
    render(<TeamBuilder {...withDiscord} onLookup={onLookup} onConfirm={onConfirm} />)

    await user.type(screen.getByLabelText(/^Team name/), 'Night Shift')
    const box = await addGrace(user)
    await user.type(screen.getByLabelText(/Add a teammate by email/), 'alan@example.test')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Alan Turing')
    // Grace gives one; Alan does not, which is allowed and must not become an empty entry.
    await user.type(box, 'grace_h')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Register the team' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Register the team' }))

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      teammateIds: [2, 3],
      teammateDiscord: [{ participantId: 2, username: 'grace_h' }],
    }))
  })
})

describe('what the form promises before the button is pressed', () => {
  it('names both channels for the registrant when they gave a username', () => {
    expect(whereItGoes({
      discordEnabled: true, mine: 'ada_dev', email: 'ada@example.test', teammatesWithDiscord: 0,
    })).toBe('Your submission code will be emailed to ada@example.test and sent to ada_dev on '
      + 'Discord. Every teammate gets it by email too.')
  })

  it('promises email alone when Discord is off, whatever was typed', () => {
    // A promise the deployment cannot keep is worse than no promise.
    expect(whereItGoes({
      discordEnabled: false, mine: 'ada_dev', email: 'ada@example.test', teammatesWithDiscord: 2,
    })).toMatch(/^Your submission code will be emailed to ada@example.test\./)
  })

  it('counts the teammates who will also get a DM', () => {
    expect(whereItGoes({
      discordEnabled: true, mine: '', email: 'ada@example.test', teammatesWithDiscord: 3,
    })).toMatch(/3 of them on Discord as well/)
  })
})
