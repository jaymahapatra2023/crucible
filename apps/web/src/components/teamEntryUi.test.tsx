/**
 * What a team sees of their own entry (E17-S03).
 *
 * The reader here has no account, no logs and no dashboard — a repository they can change and a
 * deadline. So these tests are about whether the page tells them something they can act on, and
 * whether it can be made to show them somebody else's entry. It cannot: the token is the only
 * thing that selects, and there is no field on the page that names a team.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TeamEntryStatus } from './TeamEntryStatus.js'
import * as api from '../lib/submitApi.js'
import type { TeamEntry, TeamView } from '../lib/submitApi.js'

vi.mock('../lib/submitApi.js', async (original) => ({
  ...(await original<typeof import('../lib/submitApi.js')>()),
  getMyEntry: vi.fn(),
}))

const entry = (over: Partial<TeamEntry> = {}): TeamEntry => ({
  submissionId: 1, challengeId: 1, challengeName: 'Rostering for a ward', version: 1,
  repoUrl: 'https://github.com/night-shift/rota', validationStatus: 'VALID',
  validationDetail: null, lockedCommitSha: 'a'.repeat(40),
  submittedAt: '2026-09-20T10:00:00Z', submittedOnTheirBehalf: false, remedy: null, ...over,
})

const view = (over: Partial<TeamView> = {}): TeamView => ({
  team: { teamId: 7, displayName: 'The Night Shift', contactEmail: 'night@team.test' },
  entries: [entry()],
  message: 'Everything we need is readable. Nothing to do.',
  ...over,
})

const mocked = () => vi.mocked(api.getMyEntry)

beforeEach(() => { mocked().mockReset() })

describe('checking an entry', () => {
  it('cannot be looked up without a token — there is nothing else that selects', () => {
    render(<TeamEntryStatus token="" />)
    expect(screen.getByRole('button', { name: /check my entry/i })).toBeDisabled()
    expect(screen.getByText(/Enter your submission token first/i)).toBeInTheDocument()
  })

  it('looks up with the token the team pasted, and nothing else', async () => {
    mocked().mockResolvedValue(view())
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(mocked()).toHaveBeenCalledWith('crs_abc')
    // One argument. There is no team parameter to pass, which is the point.
    expect(mocked().mock.calls[0]).toHaveLength(1)
  })

  it('names the team the token belongs to', async () => {
    mocked().mockResolvedValue(view())
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByText(/The Night Shift/)).toBeInTheDocument()
  })

  it('shows the locked commit and says later pushes will not change it', async () => {
    mocked().mockResolvedValue(view())
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByText('a'.repeat(40))).toBeInTheDocument()
    expect(screen.getByText(/Later pushes do not change it/i)).toBeInTheDocument()
  })

  it('says what is wrong AND what to do about it', async () => {
    mocked().mockResolvedValue(view({
      entries: [entry({
        validationStatus: 'PRIVATE',
        remedy: 'We cannot read your repository: make it public, then submit again.',
      })],
      message: 'One or more entries need your attention — see what to do beside each.',
    }))
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByText(/make it public/i)).toBeInTheDocument()
  })

  it('does not rely on colour to say an entry needs attention (P5.5)', async () => {
    mocked().mockResolvedValue(view({
      entries: [entry({ validationStatus: 'PRIVATE', remedy: 'Make it public.' })],
    }))
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByText(/needs your attention/i)).toBeInTheDocument()
  })

  it('says plainly when nothing has been entered yet', async () => {
    mocked().mockResolvedValue(view({
      entries: [], message: 'You have no entry recorded yet. Submitting one below is what puts it here.',
    }))
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByText(/no entry recorded yet/i)).toBeInTheDocument()
  })

  it('tells a team when an organiser entered for them', async () => {
    mocked().mockResolvedValue(view({ entries: [entry({ submittedOnTheirBehalf: true })] }))
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByText(/recorded by an organiser on your behalf/i)).toBeInTheDocument()
  })

  it('reports a rejected token as what it is, not as an empty entry', async () => {
    // Showing nothing would read as "you never submitted", which is a different and much
    // worse thing to believe on the evening of a deadline.
    mocked().mockRejectedValue(new Error('That submission token is not valid or has been revoked.'))
    render(<TeamEntryStatus token="crs_wrong" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid or has been revoked/i)
  })

  it('clears a previous result when a later lookup fails', async () => {
    mocked().mockResolvedValueOnce(view())
    render(<TeamEntryStatus token="crs_abc" />)
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(await screen.findByText(/The Night Shift/)).toBeInTheDocument()

    mocked().mockRejectedValueOnce(new Error('revoked'))
    await userEvent.click(screen.getByRole('button', { name: /check my entry/i }))
    expect(screen.queryByText(/The Night Shift/)).not.toBeInTheDocument()
  })
})

describe('where the standard is read from', () => {
  it('addresses the public published-rubric endpoint', () => {
    // It must be the endpoint that needs no account: the team reading it has none.
    expect(api.rubricHref('ward-rostering')).toBe('/api/v1/rubrics/published/ward-rostering')
  })
})
