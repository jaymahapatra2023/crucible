/**
 * The E50 surfaces: participant links as QR codes, the chase panel, the public header.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { EventLinksPanel } from './EventLinksPanel.js'
import { ChasePanel } from './ChasePanel.js'
import type { TeamToChase } from '../lib/reminderApi.js'

const getUser = vi.fn()
vi.mock('../lib/session.js', () => ({
  getUser: () => getUser(), getUserSnapshot: () => getUser(), subscribeToSession: () => () => {}, endSession: vi.fn(),
}))
const { AppShell } = await import('./AppShell.js')

describe('links for participants', () => {
  it('renders a QR code for each public page, encoding the configured address', async () => {
    render(<EventLinksPanel registerUrl="https://ev.example.org/register" submitUrl="https://ev.example.org/submit"
      canSave={false} busy={false} onSave={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
    expect(screen.getByRole('img', { name: /Register a team: https:\/\/ev.example.org\/register/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Submit an entry: https:\/\/ev.example.org\/submit/ })).toBeInTheDocument()
    expect(screen.queryByText(/not configured/)).not.toBeInTheDocument()
  })

  it('falls back to this origin and says the URLs are not configured; an admin may fix it in one click', async () => {
    const onSave = vi.fn()
    render(<EventLinksPanel registerUrl={null} submitUrl={null} canSave busy={false} onSave={onSave} />)
    expect(screen.getByRole('status')).toHaveTextContent(/not configured/)
    await userEvent.click(screen.getByRole('button', { name: /Use this address for both/ }))
    expect(onSave).toHaveBeenCalledWith({
      registerUrl: `${window.location.origin}/register`, submitUrl: `${window.location.origin}/submit`,
    })
  })
})

describe('who is not there yet', () => {
  const team = (over: Partial<TeamToChase> = {}): TeamToChase => ({
    teamId: 1, teamName: 'Idle', contactEmail: 'i@t.test', hasDiscord: false, kind: 'NOT_SUBMITTED',
    situation: 'Has not submitted.', lastReminder: null, ...over,
  })

  it('says plainly when everybody has submitted', () => {
    render(<ChasePanel teams={[]} busy={false} onRemind={vi.fn()} />)
    expect(screen.getByTestId('chase-empty')).toBeInTheDocument()
  })

  it('names each team, why, and when they were last reminded; reminds one or all', async () => {
    const onRemind = vi.fn()
    render(<ChasePanel busy={false} onRemind={onRemind} teams={[
      team(),
      team({ teamId: 2, teamName: 'Broken', kind: 'PROBLEMS', situation: 'Entry has problems: Build.', hasDiscord: true,
        lastReminder: { reminderId: 9, kind: 'PROBLEMS', status: 'SENT', channel: 'discord', detail: null, sentAt: '2026-10-03T20:00:00Z' } }),
    ]} />)
    expect(screen.getByRole('heading', { name: /1 not submitted · 1 with problems/ })).toBeInTheDocument()
    const broken = screen.getByRole('row', { name: /Broken/ })
    expect(broken).toHaveTextContent('Entry has problems: Build.')
    expect(broken).toHaveTextContent(/sent by discord/)
    expect(screen.getByRole('row', { name: /Idle/ })).toHaveTextContent('never')

    await userEvent.click(within(broken).getByRole('button', { name: 'Remind' }))
    expect(onRemind).toHaveBeenCalledWith([2])
    await userEvent.click(screen.getByRole('button', { name: /Remind all 2/ }))
    expect(onRemind).toHaveBeenCalledWith()
  })
})

describe('the header', () => {
  it('shows only the two participant pages to somebody signed out', () => {
    getUser.mockReturnValue(null)
    render(<MemoryRouter><AppShell><p>page</p></AppShell></MemoryRouter>)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav).toHaveTextContent('Register')
    expect(nav).toHaveTextContent('Submit')
    expect(nav).not.toHaveTextContent('Roster')
    expect(nav).not.toHaveTextContent('Scoring')
  })

  it('shows everything to staff', () => {
    getUser.mockReturnValue({ userId: '1', email: 'o@t.test', displayName: 'O', role: 'organiser' })
    render(<MemoryRouter><AppShell><p>page</p></AppShell></MemoryRouter>)
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveTextContent('Roster')
  })
})
