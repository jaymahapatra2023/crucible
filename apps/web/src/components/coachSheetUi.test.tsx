/**
 * A coach sheet on screen (E51): one page, questions with their reasons, and no standing unless
 * the reader is an organiser.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoachSheetView } from './CoachSheetView.js'
import { describeOutcome } from '../pages/CoachSheetsPage.js'
import type { CoachSheet } from '../lib/coachApi.js'

const sheet: CoachSheet = {
  submissionId: 7, teamId: 3, teamName: 'Night Shift', challenge: 'RealWorld Conduit',
  members: ['Ada Lovelace (contact)', 'Grace Hopper'], room: 'Ada Room', coach: 'Margaret Hamilton',
  repoUrl: 'https://github.com/night/shift', commit: 'abcdef1234567890',
  standing: { rankInRun: 2, finalRank: 3, decision: 'SHORTLIST' },
  built: { stack: ['TypeScript', 'Fastify'], capabilities: ['Sign in', 'Post articles'], endpoints: 12, integrations: ['Stripe'], runtime: 'containerised; starts with npm start', absent: false },
  ran: { outcome: 'RUNS', reason: 'Answered on :3000 within 8 s.' },
  strengths: ['Handles failures without losing work: Retries with backoff on the main path.'],
  questions: [
    { topic: 'CLAIM', because: 'The documentation says "OAuth login", but the code did not show it: no callback route.', ask: 'Can you show me where that is implemented, or is it planned rather than done?', evidence: 'README.md' },
    { topic: 'CRITERION', because: 'On "Tests cover the main path" the evaluation noted: two tests, both of the health route.', ask: 'How did you approach tests cover the main path, and what would you do next on it?', evidence: null },
  ],
  confidential: 'Scores, ranks and decisions are confidential until results are announced. Use this sheet to ask, not to tell.',
}

describe('the sheet', () => {
  it('shows who, where, what they built, whether it ran, and the questions with their reasons', () => {
    render(<CoachSheetView sheet={sheet} showStanding={false} />)
    expect(screen.getByRole('heading', { name: 'Night Shift' })).toBeInTheDocument()
    expect(screen.getByText(/RealWorld Conduit · Ada Room · coach Margaret Hamilton/)).toBeInTheDocument()
    expect(screen.getByText(/Team: Ada Lovelace \(contact\), Grace Hopper/)).toBeInTheDocument()
    expect(screen.getByText('Stack: TypeScript, Fastify')).toBeInTheDocument()
    expect(screen.getByText(/12 API endpoints · integrates Stripe/)).toBeInTheDocument()
    expect(screen.getByText('RUNS')).toBeInTheDocument()
    expect(screen.getByText(/Retries with backoff/)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Can you show me where that is implemented'),
    ]))
    expect(screen.getByText(/Because: The documentation says/)).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText(/Use this sheet to ask, not to tell/)).toBeInTheDocument()
  })

  it('keeps the standing off the coach\'s copy and on the organiser\'s', () => {
    const { rerender } = render(<CoachSheetView sheet={sheet} showStanding={false} />)
    expect(screen.queryByTestId('standing')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/SHORTLIST|rank 2/)
    rerender(<CoachSheetView sheet={sheet} showStanding />)
    expect(screen.getByTestId('standing')).toHaveTextContent('rank 2 in run · final 3 · SHORTLIST')
  })

  it('says when nothing was described, nothing ran, and nothing was flagged — rather than showing blanks', () => {
    render(<CoachSheetView showStanding={false} sheet={{
      ...sheet, built: { stack: [], capabilities: [], endpoints: 0, integrations: [], runtime: null, absent: true },
      ran: null, strengths: [], questions: [],
    }} />)
    expect(screen.getByText('No description was produced for this entry.')).toBeInTheDocument()
    expect(screen.getByText('Not probed.')).toBeInTheDocument()
    expect(screen.getByText(/Nothing the evaluation flagged/)).toBeInTheDocument()
  })
})

describe('what the send reports', () => {
  const d = (status: 'SENT' | 'PREPARED' | 'FAILED') => ({ dispatchId: 1, coachId: 1, teamIds: [1], status, detail: null, sentAt: 'now' })
  it('counts coaches by what happened to them, and names the teams nobody coaches', () => {
    expect(describeOutcome({ sent: [d('SENT'), d('SENT'), d('PREPARED')], uncoached: ['Team Outsider'] }))
      .toBe('2 coaches sent, 1 coach prepared but not transmitted (no mail provider). No coach on the roster for: Team Outsider.')
    expect(describeOutcome({ sent: [d('FAILED')], uncoached: [] })).toBe('1 coach failed.')
    expect(describeOutcome({ sent: [], uncoached: ['A', 'B'] })).toBe('Nothing was sent. No coach on the roster for: A, B.')
  })
})
