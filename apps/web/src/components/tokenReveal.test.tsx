/**
 * Revealing a code from the token panel (E47-S02, ADR 0005).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TokenPanel } from './TokenPanel.js'
import type { IssuedToken, SubmissionToken } from '../lib/intakeApi.js'

vi.mock('../lib/intakeApi.js', () => ({ similarTeams: async () => [] }))

const token = (over: Partial<SubmissionToken> = {}): SubmissionToken => ({
  tokenId: 7, label: 'Demo Team', issuedAt: '2026-10-01T00:00:00Z', expiresAt: null,
  revokedAt: null, lastUsedAt: null, teamId: 51, teamName: 'Demo Team', revealable: true, ...over,
} as SubmissionToken)

const panel = (over: Partial<Parameters<typeof TokenPanel>[0]> = {}) => render(
  <TokenPanel tokens={[token()]} teams={[]} issued={null} busy={false}
    onIssue={vi.fn()} onReissue={vi.fn()} onRevoke={vi.fn()} onDismiss={vi.fn()} {...over} />,
)

describe('reveal', () => {
  it('is offered only when the page passes an admin handler', () => {
    panel()
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument()
  })

  it('is offered for a sealed, live code, and asks the page to reveal it', async () => {
    const onReveal = vi.fn()
    panel({ onReveal })
    await userEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(onReveal).toHaveBeenCalledWith(7)
  })

  it('is not offered for a code that cannot be revealed', () => {
    panel({ onReveal: vi.fn(), tokens: [token({ revealable: false })] })
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument()
  })

  it('says a revealed code is the CURRENT one, read back under audit, not a new one', () => {
    const issued: IssuedToken = {
      tokenId: 7, label: 'Demo Team', token: 'crs_current', expiresAt: null, teamId: 51,
      teamName: 'Demo Team', revealed: true,
    }
    panel({ issued })
    expect(screen.getByText('crs_current')).toBeInTheDocument()
    expect(screen.getByText(/read back under your name/)).toBeInTheDocument()
    expect(screen.queryByText(/previous code has stopped working/)).not.toBeInTheDocument()
  })
})
