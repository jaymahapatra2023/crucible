/**
 * Issuing tokens and opening the submission window (E03-S01, E03-S04, P8.2).
 *
 * Both are prerequisites no team can work around: without a window intake refuses everyone, and
 * without a token a team cannot authenticate. Until this session neither had a UI at all, which
 * meant the only way to let teams in was curl.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TokenPanel } from './TokenPanel.js'
import { WindowPanel } from './WindowPanel.js'
import type {
  IntakeStatus, IssuedToken, SubmissionToken, TeamListing,
} from '../lib/intakeApi.js'

// The similar-name advisory asks the server, so there is one definition of "the same name".
// Stubbed here: these tests are about the panel, not about the network.
vi.mock('../lib/intakeApi.js', async (original) => ({
  ...(await original<typeof import('../lib/intakeApi.js')>()),
  similarTeams: vi.fn(async () => []),
}))

const token = (over: Partial<SubmissionToken> = {}): SubmissionToken => ({
  tokenId: 1, label: 'The Night Shift', issuedAt: '2026-09-01T10:00:00Z', revealable: false,
  expiresAt: null, revokedAt: null, lastUsedAt: '2026-09-02T11:00:00Z',
  teamId: 7, teamName: 'The Night Shift', ...over,
})

const team = (over: Partial<TeamListing> = {}): TeamListing => ({
  teamId: 7, displayName: 'The Night Shift', normalisedName: 'nightshift',
  contactEmail: 'night@team.test', origin: 'TOKEN', createdAt: '2026-09-01T10:00:00Z',
  activeTokens: 1, currentSubmissions: 1, ...over,
})

const issued: IssuedToken = {
  tokenId: 2, label: 'Team Crucible', token: 'crs_abc123', expiresAt: null,
  teamId: 9, teamName: 'Team Crucible',
}

describe('submission tokens', () => {
  it('says no team can submit until one is issued', () => {
    render(<TokenPanel tokens={[]} teams={[]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/Until one is, no team can submit/i)).toBeInTheDocument()
  })

  it('points the organiser at the page teams use', () => {
    render(<TokenPanel tokens={[]} teams={[]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByRole('link', { name: /submission page/i }))
      .toHaveAttribute('href', '/submit')
  })

  it('shows a newly issued token and warns it cannot be shown again', () => {
    // Only the SHA-256 is stored, so this is the one moment the plaintext exists. A token lost
    // here is a team that cannot enter.
    render(<TokenPanel tokens={[]} teams={[]} issued={issued} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText('crs_abc123')).toBeInTheDocument()
    expect(screen.getByText(/cannot be shown again/i)).toBeInTheDocument()
  })

  it('keeps the token on screen until the organiser says they have copied it', async () => {
    const onDismiss = vi.fn()
    render(<TokenPanel tokens={[]} teams={[]} issued={issued} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: /I have copied it/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('will not issue a token without a team name to attribute it to', () => {
    render(<TokenPanel tokens={[]} teams={[]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByRole('button', { name: /create team and issue token/i })).toBeDisabled()
  })

  it('will not issue one without a contact either — there is no account to fall back on', async () => {
    render(<TokenPanel tokens={[]} teams={[]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/Team name/), 'The Night Shift')
    expect(screen.getByRole('button', { name: /create team and issue token/i })).toBeDisabled()
  })

  it('creates the team as it issues, carrying its contact (E17-S01)', async () => {
    const onIssue = vi.fn()
    render(<TokenPanel tokens={[]} teams={[]} issued={null} busy={false}
      onIssue={onIssue} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/Team name/), 'The Night Shift')
    await userEvent.type(screen.getByLabelText(/Contact email/), 'night@team.test')
    await userEvent.click(screen.getByRole('button', { name: /create team and issue token/i }))
    expect(onIssue).toHaveBeenCalledWith({
      label: 'The Night Shift', contactEmail: 'night@team.test',
    })
  })

  it('reissues against an EXISTING team by id, not by retyping the name', async () => {
    // The whole point of E17: a replacement token is the same team, so the version chain and
    // everything keyed on identity survives a revocation. Since E47-S01 a replacement also stops
    // the old code, so it asks why.
    const onReissue = vi.fn()
    render(<TokenPanel tokens={[]} teams={[team()]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={onReissue} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    await userEvent.selectOptions(screen.getByLabelText(/^Team$/), '7')
    await userEvent.type(screen.getByLabelText(/Why the code is being replaced/), 'lost')
    await userEvent.click(screen.getByRole('button', { name: /Replace this team's code/i }))
    expect(onReissue).toHaveBeenCalledWith(7, 'lost')
  })

  it('asks for no name or contact when reissuing — the team already has both', async () => {
    render(<TokenPanel tokens={[]} teams={[team()]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    await userEvent.selectOptions(screen.getByLabelText(/^Team$/), '7')
    expect(screen.queryByLabelText(/Team name/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Contact email/)).not.toBeInTheDocument()
  })

  it('names the teams that have no working token and cannot submit', () => {
    // A team whose only token was revoked still looks like a team everywhere else. Left unsaid,
    // this surfaces at a deadline, when it is no longer fixable.
    render(<TokenPanel tokens={[]} teams={[team({ activeTokens: 0 })]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    // Named, not counted: an organiser has to know WHICH team to reissue for.
    expect(screen.getByRole('status')).toHaveTextContent(/no working token and cannot submit/i)
    expect(screen.getByRole('status')).toHaveTextContent(/The Night Shift/)
  })

  it('says nothing when every team can submit', () => {
    render(<TokenPanel tokens={[]} teams={[team()]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.queryByText(/cannot submit/i)).not.toBeInTheDocument()
  })

  it('shows a token that is not bound to a team, rather than letting it fail at the deadline', () => {
    render(<TokenPanel tokens={[token({ teamId: null, teamName: null })]} teams={[]}
      issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/not bound to a team/i)).toBeInTheDocument()
  })

  it('flags a token that has never been used', () => {
    // Before a deadline this usually means the token never reached the team — which is
    // recoverable then, and is not recoverable afterwards.
    render(<TokenPanel tokens={[token({ lastUsedAt: null })]} teams={[]} issued={null} busy={false}
      onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText('never used')).toBeInTheDocument()
  })

  it('offers no revoke on an already revoked token', () => {
    render(<TokenPanel tokens={[token({ revokedAt: '2026-09-03T00:00:00Z' })]} teams={[]} issued={null}
      busy={false} onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByText(/revoked/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^revoke$/i })).not.toBeInTheDocument()
  })
})

const status = (over: Partial<IntakeStatus> = {}): IntakeStatus => ({
  state: 'OPEN', message: 'Submissions are open.',
  window: {
    name: 'Hackathon intake', opensAt: '2026-09-01T09:00:00Z',
    closesAt: '2026-09-30T17:00:00Z', lockedAt: null,
  },
  ...over,
})

describe('the submission window', () => {
  it('says plainly that no window means no team can submit', () => {
    // The single most likely cause of a panicked message on the night — and the page header
    // does not say it, which is why this panel does.
    render(<WindowPanel status={status({ state: 'NO_WINDOW', window: null })}
      busy={false} onSave={vi.fn()} onLock={vi.fn()} />)
    expect(screen.getByText(/no team can submit/i)).toBeInTheDocument()
  })

  it('offers to set one when there is none', () => {
    render(<WindowPanel status={status({ state: 'NO_WINDOW', window: null })}
      busy={false} onSave={vi.fn()} onLock={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Set the window' })).toBeInTheDocument()
  })

  it('refuses a window that closes before it opens', async () => {
    render(<WindowPanel status={status()} busy={false} onSave={vi.fn()} onLock={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /change the window/i }))

    await userEvent.clear(screen.getByLabelText(/Closes/))
    await userEvent.type(screen.getByLabelText(/Closes/), '2026-08-01T09:00')
    expect(screen.getByRole('alert')).toHaveTextContent(/must close after it opens/i)
    expect(screen.getByRole('button', { name: 'Save window' })).toBeDisabled()
  })

  it('offers no editing at all once intake is locked', () => {
    render(<WindowPanel status={status({ state: 'LOCKED' })} busy={false}
      onSave={vi.fn()} onLock={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /change the window/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /lock intake/i })).not.toBeInTheDocument()
  })

  it('says locking is irreversible and closing is not', () => {
    render(<WindowPanel status={status()} busy={false} onSave={vi.fn()} onLock={vi.fn()} />)
    expect(screen.getByText(/Closing the window by date is reversible; locking is not/i))
      .toBeInTheDocument()
  })

  it('asks for confirmation before locking, and does not lock if declined', async () => {
    const onLock = vi.fn()
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    try {
      render(<WindowPanel status={status()} busy={false} onSave={vi.fn()} onLock={onLock} />)
      await userEvent.click(screen.getByRole('button', { name: /lock intake permanently/i }))
      expect(confirm).toHaveBeenCalled()
      expect(onLock).not.toHaveBeenCalled()
    } finally {
      confirm.mockRestore()
    }
  })

  it('names what locking costs, including the team whose repository turned out private', async () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    try {
      render(<WindowPanel status={status()} busy={false} onSave={vi.fn()} onLock={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /lock intake permanently/i }))
      expect(confirm.mock.calls[0]?.[0]).toMatch(/repository turned out to be private/i)
    } finally {
      confirm.mockRestore()
    }
  })
})
