/**
 * Replacing a code and correcting a team (E47-S01, E48-S01).
 *
 * The two things an organiser must not be able to do by accident: revoke a team's working code
 * without saying why, and rename a team into another one.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TokenPanel } from './TokenPanel.js'
import { TeamEditControl } from './TeamEditControl.js'
import { TeamList } from './TeamList.js'
import type { IssuedToken, SubmissionToken, TeamListing } from '../lib/intakeApi.js'
import type { TeamOnBoard } from '../lib/rosterApi.js'

vi.mock('../lib/intakeApi.js', () => ({ similarTeams: async () => [] }))

const team: TeamListing = {
  teamId: 51, displayName: 'Demo Team', contactEmail: 'demo@team.test', origin: 'ORGANISER',
  createdAt: '2026-10-01T00:00:00Z', activeTokens: 1, currentSubmissions: 0,
} as TeamListing

const token: SubmissionToken = {
  tokenId: 7, label: 'Demo Team', issuedAt: '2026-10-01T00:00:00Z', expiresAt: null, revealable: true,
  revokedAt: null, lastUsedAt: null, teamId: 51, teamName: 'Demo Team',
} as SubmissionToken

const panel = (over: Partial<Parameters<typeof TokenPanel>[0]> = {}) => render(
  <TokenPanel tokens={[token]} teams={[team]} issued={null} busy={false}
    onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} {...over} />,
)

describe('replacing a code', () => {
  it('asks why, and will not replace without a reason', async () => {
    const onReissue = vi.fn()
    panel({ onReissue })
    await userEvent.selectOptions(screen.getByLabelText('Team'), '51')

    const button = screen.getByRole('button', { name: /Replace this team's code/ })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Why the code is being replaced/), 'team lost it')
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onReissue).toHaveBeenCalledWith(51, 'team lost it')
  })

  it('says the previous code has stopped working once a replacement is shown', () => {
    const issued: IssuedToken = {
      tokenId: 8, label: 'Demo Team', token: 'crs_new', expiresAt: null, teamId: 51,
      teamName: 'Demo Team', revoked: 1,
    }
    panel({ issued })
    expect(screen.getByText(/previous code has stopped working/)).toBeInTheDocument()
    expect(screen.getByText('crs_new')).toBeInTheDocument()
  })

  it('does not claim a code stopped when none did', () => {
    const issued: IssuedToken = {
      tokenId: 8, label: 'New Team', token: 'crs_new', expiresAt: null, teamId: 52,
      teamName: 'New Team', revoked: 0,
    }
    panel({ issued })
    expect(screen.queryByText(/previous code has stopped working/)).not.toBeInTheDocument()
  })
})

describe('correcting a team', () => {
  it('sends only what changed', async () => {
    const onSave = vi.fn()
    render(<TeamEditControl teamId={51} displayName="Demo Team" contactEmail="demo@team.test"
      busy={false} onSave={onSave} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit team #51' }))
    const name = screen.getByLabelText('Team name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Demo Team Prime')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(51, { displayName: 'Demo Team Prime' })
  })

  it('will not save nothing, or an address that is not one', async () => {
    render(<TeamEditControl teamId={51} displayName="Demo Team" contactEmail="demo@team.test"
      busy={false} onSave={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit team #51' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    const contact = screen.getByLabelText('Contact email')
    await userEvent.clear(contact)
    await userEvent.type(contact, 'not-an-address')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('is offered from the token row on the intake page', async () => {
    const onEditTeam = vi.fn()
    panel({ onEditTeam })
    expect(screen.getByRole('button', { name: 'Edit team #51' })).toBeInTheDocument()
  })

  it('is offered on the selected team on the roster board', () => {
    const onBoard: TeamOnBoard = {
      teamId: 51, displayName: 'Demo Team', contactEmail: 'demo@team.test', members: [],
      roomLabel: null, coachName: null,
    }
    render(<TeamList teams={[onBoard]} selectedId={51} busy={false} onSelect={vi.fn()}
      onUnassign={vi.fn()} onSetContact={vi.fn()} onEdit={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Edit team #51' })).toBeInTheDocument()
  })
})
