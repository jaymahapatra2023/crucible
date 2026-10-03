/**
 * Review UI (E08-S01 … E08-S06).
 *
 * Two things these tests defend. First, data honesty: a total that describes the fetched page
 * rather than the field is the most convincing lie this system could tell. Second, that a
 * decision and a dismissal both demand a reason at the point of entry, with the control saying
 * what the reason is for — "required" produces a field full of "ok".
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ReviewTableView } from './ReviewTableView.js'
import { FlagList } from './FlagList.js'
import { DecisionPanel } from './DecisionPanel.js'
import { ShortlistBar } from './ShortlistBar.js'
import { RunComparison } from './RunComparison.js'
import { ProbeSummary } from './ProbeSummary.js'
import type {
  DecisionHistoryEntry,
  ReviewFlag, ReviewRow, ReviewTable, RunDifference, ShortlistState,
} from '../lib/reviewApi.js'

const dimension = (name: string, score: number | null, weight = 0.2, quality = 'COMPLETE') =>
  ({ dimension: name, score, dataQuality: quality as 'COMPLETE', weight })

const row = (overrides: Partial<ReviewRow> = {}): ReviewRow => ({
  submission_id: 7, challenge_id: 1, team_name: 'Team Alpha', composite: 81.4,
  rank_global: 3, rank_in_challenge: 2, tied: false, partial: false,
  in_cut_band: false, advisory_decided: false, requires_review: false,
  weight_covered: 1, missing_dimensions: [], normalisation_method: 'PERCENTILE',
  open_flags: 0, dismissed_flags: 0, decision: null, decision_reason: null,
  dimensions: [
    dimension('CHALLENGE_FIDELITY', 88, 0.3), dimension('ENGINEERING_QUALITY', 75, 0.25),
    dimension('PRINCIPLES_STANDARDS', 60, 0.2), dimension('RUNS', null, 0.2, 'UNSCORED'),
    dimension('ORIGINALITY', 50, 0.05),
  ],
  ...overrides,
})

const table = (overrides: Partial<ReviewTable> = {}): ReviewTable => ({
  rows: [row()], total: 1, totalUnfiltered: 1, limit: 100, offset: 0, sort: 'rank',
  counts: { inCutBand: 0, requiresReview: 0, withOpenFlags: 0, decided: 0 },
  ...overrides,
})

const withRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('the ranked table (E08-S01)', () => {
  it('shows rank, team, composite and the dimension breakdown in one row', () => {
    withRouter(<ReviewTableView table={table()} runId={5} />)

    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Team Alpha' })).toBeInTheDocument()
    expect(screen.getByText('81.4')).toBeInTheDocument()
    expect(screen.getByTestId('dim-7-CHALLENGE_FIDELITY')).toHaveTextContent('88')
  })

  it('marks the cut-line band as visually distinct (acceptance 3)', () => {
    withRouter(<ReviewTableView table={table({ rows: [row({ in_cut_band: true })] })} runId={5} />)
    expect(screen.getByTestId('row-7')).toHaveAttribute('data-band', 'true')
  })

  it('renders an UNSCORED dimension as a dash, never as a zero', () => {
    withRouter(<ReviewTableView table={table()} runId={5} />)
    const cell = screen.getByTestId('dim-7-RUNS')
    expect(cell).toHaveTextContent('—')
    expect(cell).not.toHaveTextContent('0')
  })

  it('distinguishes "carries no weight" from "could not be scored"', () => {
    withRouter(<ReviewTableView table={table({
      rows: [row({ dimensions: [dimension('RUNS', null, 0, 'UNSCORED')] })],
    })} runId={5} />)
    expect(screen.getByTestId('dim-7-RUNS')).toHaveTextContent('n/a')
  })

  it('marks a partially-evidenced dimension rather than presenting it as complete', () => {
    withRouter(<ReviewTableView table={table({
      rows: [row({ dimensions: [dimension('RUNS', 60, 0.2, 'PARTIAL')] })],
    })} runId={5} />)
    expect(screen.getByTestId('dim-7-RUNS')).toHaveTextContent('60*')
  })

  it('offers sortable headings that REFETCH rather than reorder the page', async () => {
    const onSort = vi.fn()
    withRouter(<ReviewTableView table={table()} runId={5} onSort={onSort} />)

    await userEvent.click(screen.getByTestId('sort-ENGINEERING_QUALITY'))
    expect(onSort).toHaveBeenCalledWith('ENGINEERING_QUALITY')
  })

  it('marks the active sort for assistive technology', () => {
    withRouter(<ReviewTableView table={table({ sort: 'composite' })} runId={5} onSort={vi.fn()} />)
    expect(screen.getByTestId('sort-composite').closest('th'))
      .toHaveAttribute('aria-sort', 'descending')
  })

  it('shows an override wherever the team appears (E08-S04 acceptance 3)', () => {
    withRouter(<ReviewTableView table={table({
      rows: [row({ decision: 'EXCLUDE', decision_reason: 'Work predates the event window.' })],
    })} runId={5} />)
    expect(screen.getByText('EXCLUDE')).toBeInTheDocument()
  })
})

describe('data honesty (E08-S06 acceptance 1)', () => {
  it('shows BACKEND totals, not the number of rows fetched', () => {
    withRouter(<ReviewTableView
      table={table({ rows: [row()], total: 48, totalUnfiltered: 48 })} runId={5} />)
    // One row rendered, forty-eight in the field — and the screen says so.
    expect(screen.getByTestId('showing-count')).toHaveTextContent('Showing 1 of 48')
  })

  it('reports the unfiltered total alongside the filtered one', () => {
    withRouter(<ReviewTableView
      table={table({ rows: [row()], total: 3, totalUnfiltered: 48 })} runId={5} />)
    expect(screen.getByText(/48 in total/)).toBeInTheDocument()
  })

  it('takes its summary counts from the backend', () => {
    withRouter(<ReviewTableView table={table({
      counts: { inCutBand: 6, requiresReview: 9, withOpenFlags: 12, decided: 4 },
    })} runId={5} />)

    expect(screen.getByTestId('band-count')).toHaveTextContent('6')
    expect(screen.getByTestId('flagged-count')).toHaveTextContent('12')
    expect(screen.getByTestId('decided-count')).toHaveTextContent('4')
  })
})

describe('flags (E08-S03)', () => {
  const flag = (overrides: Partial<ReviewFlag> = {}): ReviewFlag => ({
    submission_id: 7, code: 'SCAN_TRUNCATED', severity: 'ATTENTION',
    message: 'The scanner read 40 of 400 files before reaching its budget, so every score for this team was formed from part of the repository.',
    detail: {}, dismissed: false, dismissed_by: null, dismissal_reason: null,
    ...overrides,
  })

  it('shows what each flag MEANS, not its code (acceptance 2)', () => {
    render(<FlagList flags={[flag()]} />)
    expect(screen.getByText(/read 40 of 400 files/)).toBeInTheDocument()
    expect(screen.queryByText('SCAN_TRUNCATED')).not.toBeInTheDocument()
  })

  it('says plainly that no flag excludes anyone', () => {
    render(<FlagList flags={[flag()]} />)
    expect(screen.getByText(/None of them excludes anyone/)).toBeInTheDocument()
  })

  it('REFUSES to dismiss without a reason (acceptance 3)', async () => {
    const onDismiss = vi.fn()
    render(<FlagList flags={[flag()]} onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: /Dismiss this caveat/ }))
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText(/Why can this be set aside/), 'too short')
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('says what the reason will be USED for, not merely that it is required', async () => {
    render(<FlagList flags={[flag()]} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Dismiss this caveat/ }))
    expect(screen.getByText(/why was this ignored/)).toBeInTheDocument()
  })

  it('dismisses with a real reason', async () => {
    const onDismiss = vi.fn()
    render(<FlagList flags={[flag()]} onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('button', { name: /Dismiss this caveat/ }))
    await userEvent.type(
      screen.getByLabelText(/Why can this be set aside/),
      'The unread files are vendored dependencies.')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(onDismiss).toHaveBeenCalledWith(
      'SCAN_TRUNCATED', 'The unread files are vendored dependencies.')
  })

  it('KEEPS a dismissed flag visible, with who set it aside and why', () => {
    render(<FlagList flags={[flag({
      dismissed: true, dismissed_by: 'chair@test.local',
      dismissal_reason: 'Vendored dependencies; not the team’s code.',
    })]} />)
    expect(screen.getByText(/chair@test.local/)).toBeInTheDocument()
    expect(screen.getByText(/Vendored dependencies/)).toBeInTheDocument()
  })

  it('counts only the OPEN flags in the heading', () => {
    render(<FlagList flags={[flag(), flag({ code: 'NOT_PROBED', dismissed: true, dismissed_by: 'x', dismissal_reason: 'y'.repeat(12) })]} />)
    expect(screen.getByRole('heading', { name: /1 open/ })).toBeInTheDocument()
  })

  it('says so when nothing was flagged, rather than rendering an empty box', () => {
    render(<FlagList flags={[]} />)
    expect(screen.getByText(/No automated caveats/)).toBeInTheDocument()
  })
})

describe('recording a decision (E08-S04)', () => {
  it('offers shortlist, exclude and hold, and explains hold', () => {
    render(<DecisionPanel existing={null} locked={false} onDecide={vi.fn()} />)
    expect(screen.getByLabelText(/Shortlist/)).toBeInTheDocument()
    expect(screen.getByText(/Blocks finalising/)).toBeInTheDocument()
  })

  it('REFUSES a decision without a reason (acceptance 1)', async () => {
    const onDecide = vi.fn()
    render(<DecisionPanel existing={null} locked={false} onDecide={onDecide} />)

    expect(screen.getByRole('button', { name: /Record decision/ })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Reason'), 'nope')
    expect(screen.getByRole('button', { name: /Record decision/ })).toBeDisabled()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('records the chosen decision with its reason', async () => {
    const onDecide = vi.fn()
    render(<DecisionPanel existing={null} locked={false} onDecide={onDecide} />)

    await userEvent.click(screen.getByLabelText(/Exclude/))
    await userEvent.type(screen.getByLabelText('Reason'), 'Repository contains another team’s work.')
    await userEvent.click(screen.getByRole('button', { name: /Record decision/ }))

    expect(onDecide).toHaveBeenCalledWith('EXCLUDE', 'Repository contains another team’s work.')
  })

  it('SHOWS an existing decision and its author before it can be changed', () => {
    render(<DecisionPanel locked={false} onDecide={vi.fn()} existing={{
      submission_id: 7, decision: 'HOLD', reason: 'Waiting on the appeal.',
      decided_by: 'chair@test.local', decided_at: '2026-02-01T00:00:00Z', rank_at_decision: 21,
    }} />)

    const existing = screen.getByTestId('existing-decision')
    expect(existing).toHaveTextContent('HOLD')
    expect(existing).toHaveTextContent('chair@test.local')
    expect(existing).toHaveTextContent('rank 21')
  })

  it('DISABLES the control once the shortlist is final (acceptance 2)', () => {
    render(<DecisionPanel existing={null} locked onDecide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Record decision/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/cannot be changed/)
  })
})

describe('finalising (E08-S05)', () => {
  const shortlist = (overrides: Partial<ShortlistState> = {}): ShortlistState => ({
    shortlist: {
      shortlist_id: 1, status: 'OPEN', name: 'Finals',
      finalised_by: null, finalised_at: null, rubric_versions: {},
    },
    decisions: [], counts: { SHORTLIST: 4, EXCLUDE: 2, HOLD: 1 }, blocking: [],
    ...overrides,
  })

  it('shows the decision counts from the backend', () => {
    render(<ShortlistBar shortlist={shortlist()} onFinalise={vi.fn()} />)
    expect(screen.getByTestId('count-shortlisted')).toHaveTextContent('4')
    expect(screen.getByTestId('count-held')).toHaveTextContent('1')
  })

  it('BLOCKS finalising while the cut band is unresolved, naming the ranks', () => {
    render(<ShortlistBar onFinalise={vi.fn()} shortlist={shortlist({
      blocking: [
        { submission_id: 9, rank_global: 24, state: 'UNDECIDED' },
        { submission_id: 12, rank_global: 26, state: 'HOLD' },
      ],
    })} />)

    expect(screen.getByRole('button', { name: /Finalise/ })).toBeDisabled()
    expect(screen.getByTestId('finalise-blocked')).toHaveTextContent('24, 26')
  })

  it('explains WHY those submissions block it', () => {
    render(<ShortlistBar onFinalise={vi.fn()} shortlist={shortlist({
      blocking: [{ submission_id: 9, rank_global: 24, state: 'UNDECIDED' }],
    })} />)
    expect(screen.getByTestId('finalise-blocked'))
      .toHaveTextContent(/your judgement changes the outcome/)
  })

  it('finalises when nothing is blocking', async () => {
    const onFinalise = vi.fn()
    render(<ShortlistBar shortlist={shortlist()} onFinalise={onFinalise} />)
    await userEvent.click(screen.getByRole('button', { name: /Finalise/ }))
    expect(onFinalise).toHaveBeenCalled()
  })

  it('shows who locked it once final, and offers no finalise button', () => {
    render(<ShortlistBar onFinalise={vi.fn()} shortlist={shortlist({
      shortlist: {
        shortlist_id: 1, status: 'FINAL', name: 'Finals',
        finalised_by: 'chair@test.local', finalised_at: '2026-02-01T00:00:00Z',
        rubric_versions: { '1': 2 },
      },
    })} />)

    expect(screen.getByText(/Locked by chair@test.local/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Finalise/ })).not.toBeInTheDocument()
  })
})

describe('the two runs side by side (E08-S02 acceptance 5)', () => {
  const difference = (overrides: Partial<RunDifference> = {}): RunDifference => ({
    criterionId: 4, dimension: 'ENGINEERING_QUALITY',
    runA: { runIndex: 1, rawScore: 4, nonScore: null, rationale: 'Retries with backoff throughout.' },
    runB: { runIndex: 2, rawScore: 1, nonScore: null, rationale: 'Only one call site retries.' },
    ...overrides,
  })

  it('shows both runs’ scores and both rationales', () => {
    render(<RunComparison differences={[difference()]} />)
    const card = screen.getByTestId('difference-4')
    expect(within(card).getByText('4')).toBeInTheDocument()
    expect(within(card).getByText('1')).toBeInTheDocument()
    expect(within(card).getByText(/Only one call site retries/)).toBeInTheDocument()
  })

  it('says the gap measures reliability, not quality', () => {
    render(<RunComparison differences={[difference()]} />)
    expect(screen.getByText(/not how good it is/)).toBeInTheDocument()
  })

  it('renders a non-score as its reason, never as a zero', () => {
    render(<RunComparison differences={[difference({
      runB: { runIndex: 2, rawScore: null, nonScore: 'INSUFFICIENT_EVIDENCE', rationale: 'Nothing to point at.' },
    })]} />)

    const card = screen.getByTestId('difference-4')
    expect(within(card).getByText('Not enough evidence')).toBeInTheDocument()
    expect(within(card).queryByText('0')).not.toBeInTheDocument()
  })

  it('distinguishes agreement from having only one run', () => {
    render(<RunComparison differences={[]} />)
    expect(screen.getByText(/or only one run has been scored/)).toBeInTheDocument()
  })
})

describe('the build probe and provenance (E08-S02 acceptance 3 and 4)', () => {
  it('shows the grade, the reason and a link to the log', () => {
    render(<ProbeSummary provenance={[]} probe={{
      probe_id: 12, outcome: 'SUCCESS', runs_grade: 'BUILDS_ONLY',
      grade_reason: 'The build command exited 0.', log_truncated: false,
    }} />)

    expect(screen.getByTestId('probe-grade')).toHaveTextContent('BUILDS_ONLY')
    // A button rather than a link: the log endpoint is authenticated and audited, so it is
    // fetched with the session token rather than navigated to.
    expect(screen.getByTestId('probe-log')).toHaveTextContent(/build log/)
  })

  it('says an unsupported stack is OUR limitation, not the team’s fault', () => {
    render(<ProbeSummary provenance={[]} probe={{
      probe_id: 12, outcome: 'UNSUPPORTED_STACK', runs_grade: 'UNSUPPORTED_STACK',
      grade_reason: 'No recipe for this stack.', log_truncated: false,
    }} />)
    expect(screen.getByText(/has no recipe for this stack/)).toBeInTheDocument()
  })

  it('says an unprobed submission was EXCLUDED, not scored zero', () => {
    render(<ProbeSummary probe={null} provenance={[]} />)
    expect(screen.getByText(/rather than scored zero/)).toBeInTheDocument()
  })

  it('shows provenance observations as the scanner worded them', () => {
    render(<ProbeSummary probe={null} provenance={[
      { code: 'NO_HISTORY', message: 'No readable git history; common when a repo is uploaded.' },
    ]} />)
    expect(screen.getByText(/common when a repo is uploaded/)).toBeInTheDocument()
  })

  it('says so when nothing in the history needed a look', () => {
    render(<ProbeSummary probe={null} provenance={[]} />)
    expect(screen.getByText(/Nothing in the commit history needed a second look/))
      .toBeInTheDocument()
  })
})

describe('moving a team, and what it moved from (E23)', () => {
  const entry = (over: Partial<DecisionHistoryEntry> = {}): DecisionHistoryEntry => ({
    id: 1, decision: 'SHORTLIST', reason: 'Strong across every dimension we could evidence.',
    decided_by: 'chair@test.local', decided_at: '2026-09-20T10:00:00Z',
    rank_at_decision: 3, superseded_at: '2026-09-21T09:00:00Z', ...over,
  })

  it('says nothing when a team has only ever been decided once', () => {
    // A history of one is not a history; showing "moved 0 times" would be noise on every team.
    render(<DecisionPanel existing={null} history={[]} locked={false} onDecide={vi.fn()} />)
    expect(screen.queryByTestId('decision-history')).not.toBeInTheDocument()
  })

  it('shows what the team was moved FROM, with who moved them and why', async () => {
    render(<DecisionPanel
      existing={{
        submission_id: 1, decision: 'EXCLUDE', reason: 'Withdrew after the deadline.',
        decided_by: 'organiser@test.local', decided_at: '2026-09-21T09:00:00Z',
        rank_at_decision: 3,
      }}
      history={[entry({ id: 2, decision: 'EXCLUDE', superseded_at: null }), entry()]}
      locked={false} onDecide={vi.fn()} />)

    await userEvent.click(screen.getByText(/Moved once before this/))
    expect(screen.getByText('SHORTLIST')).toBeInTheDocument()
    expect(screen.getByText(/chair@test.local/)).toBeInTheDocument()
    expect(screen.getByText(/Strong across every dimension/)).toBeInTheDocument()
  })

  it('counts only the decisions that were superseded, not the one that stands', () => {
    render(<DecisionPanel
      existing={null}
      history={[
        entry({ id: 3, superseded_at: null }),
        entry({ id: 2, decision: 'HOLD' }),
        entry({ id: 1 }),
      ]}
      locked={false} onDecide={vi.fn()} />)

    expect(screen.getByText(/Moved 2 times before this/)).toBeInTheDocument()
  })

  it('offers all three states, so a team can be moved to any of them', () => {
    render(<DecisionPanel existing={null} history={[]} locked={false} onDecide={vi.fn()} />)
    for (const label of ['Shortlist', 'Exclude', 'Hold']) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeInTheDocument()
    }
  })
})
