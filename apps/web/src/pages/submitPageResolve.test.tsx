/**
 * The token is the team (E45-S01).
 *
 * The form used to ask for a team name and rename the team to whatever was typed. Now the token
 * resolves to the team it names, the page says so, and the team's own contact address fills the
 * email field — which the team may still correct, and which must not refill under them.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClientError } from '../lib/apiClient.js'
import type { TeamView } from '../lib/submitApi.js'

const resolveToken = vi.fn()
vi.mock('../lib/submitApi.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/submitApi.js')>(),
  getIntakeWindow: async () => ({ state: 'OPEN', message: 'Entries are being accepted.', window: null }),
  getOpenChallenges: async () => [{ challengeId: 1, name: 'Rostering', rubricSlug: null }],
  resolveToken: (t: string) => resolveToken(t),
  getMyEntry: (t: string) => resolveToken(t),
}))

const { SubmitPage } = await import('./SubmitPage.js')

const view = (over: Partial<TeamView['team']> = {}): TeamView => ({
  team: { teamId: 51, displayName: 'Demo Team', contactEmail: 'demo@team.test', ...over },
  entries: [], message: 'No entry yet.',
})

// Braces matter: a hook's return value is run as a cleanup, and `mockReset()` returns the mock.
beforeEach(() => { resolveToken.mockReset() })

describe('the token resolves to the team', () => {
  it('shows the team the token names — there is no team name field to type into', async () => {
    resolveToken.mockResolvedValue(view())
    render(<SubmitPage />)
    await userEvent.type(await screen.findByLabelText(/^Submission token/), 'crs_valid-token')

    await waitFor(() => expect(screen.getByTestId('resolved-team')).toHaveTextContent('Demo Team'))
    expect(screen.queryByLabelText(/^Team name/)).not.toBeInTheDocument()
    expect(resolveToken).toHaveBeenCalledWith('crs_valid-token')
  })

  it("fills the contact from the team, and keeps the team's correction", async () => {
    resolveToken.mockResolvedValue(view())
    render(<SubmitPage />)
    await userEvent.type(await screen.findByLabelText(/^Submission token/), 'crs_valid-token')
    const email = screen.getByLabelText(/^Contact email/)
    await waitFor(() => expect(email).toHaveValue('demo@team.test'))

    await userEvent.clear(email)
    // A cleared field stays cleared: the resolved contact is a starting point, not a floor.
    expect(email).toHaveValue('')
    await userEvent.type(email, 'lead@team.test')
    expect(email).toHaveValue('lead@team.test')
  })

  it('reports a token bound to no team at the field, before anything is submitted', async () => {
    resolveToken.mockRejectedValue(
      new ApiClientError('UNAUTHENTICATED', 'This token is not valid for any team.', 401))
    render(<SubmitPage />)
    await userEvent.type(await screen.findByLabelText(/^Submission token/), 'crs_unbound-token')

    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid for any team/)
    expect(screen.queryByTestId('resolved-team')).not.toBeInTheDocument()
  })

  it('does not look up a token that is still being typed', async () => {
    resolveToken.mockResolvedValue(view())
    render(<SubmitPage />)
    await userEvent.type(await screen.findByLabelText(/^Submission token/), 'crs_')
    await new Promise((r) => setTimeout(r, 500))
    expect(resolveToken).not.toHaveBeenCalled()
  })
})
