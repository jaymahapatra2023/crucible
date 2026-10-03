/**
 * Every entry, and starting a run (E39).
 *
 * Both surfaces existed on the server and were reachable only by curl. The tests concentrate on
 * the two things that made that dangerous on the night: a valid entry being invisible, and a
 * cohort key being chosen without understanding what it scopes.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { SubmissionsTable } from './SubmissionsTable.js'
import { StartRunPanel } from './StartRunPanel.js'
import type { SubmissionPage, SubmissionRow } from '../lib/intakeApi.js'
import type { Challenge } from '../lib/challengeApi.js'

const row = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
  submissionId: 78, teamId: 51, teamName: 'Demo Team', contactEmail: 'a@b.test',
  challengeId: 9, repoUrl: 'https://github.com/a/b', buildMethod: 'DOCKERFILE',
  version: 1, validationStatus: 'VALID', validationDetail: 'Cloned successfully.',
  lockedCommitSha: null, submittedAt: '2026-10-03T13:00:00Z', submittedVia: 'TEAM_TOKEN',
  preflight: null,
  ...over,
})

const page = (items: SubmissionRow[], total = items.length): SubmissionPage =>
  ({ items, total, page: 1, pageSize: 200, truncated: false })

const NAMES = new Map([[9, 'RealWorld Conduit'], [8, 'Telemetry Triage']])

const withRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>)

describe('a valid entry is visible at last', () => {
  it('lists a VALID submission, which the dashboard never itemised', () => {
    withRouter(<SubmissionsTable page={page([row()])} challengeNames={NAMES}
      busy={false} query={{}} onQuery={vi.fn()} />)

    const found = screen.getByRole('row', { name: /Demo Team/ })
    expect(found).toHaveTextContent('VALID')
    expect(found).toHaveTextContent('RealWorld Conduit')
  })

  it('names the challenge rather than showing its id', () => {
    withRouter(<SubmissionsTable page={page([row({ challengeId: 8 })])} challengeNames={NAMES}
      busy={false} query={{}} onQuery={vi.fn()} />)

    // Scoped to the row: the name is also a filter option, which is not the thing being checked.
    expect(screen.getByRole('row', { name: /Demo Team/ })).toHaveTextContent('Telemetry Triage')
    expect(screen.queryByText('#8')).not.toBeInTheDocument()
  })

  it('shows a failure reason but does not repeat one for a valid entry', () => {
    withRouter(<SubmissionsTable challengeNames={NAMES} busy={false}
      query={{}} onQuery={vi.fn()}
      page={page([
        row(),
        row({ submissionId: 79, teamName: 'Beta', validationStatus: 'PRIVATE',
          validationDetail: 'GitHub would not serve this anonymously.' }),
      ])} />)

    expect(screen.getByText(/would not serve this anonymously/)).toBeInTheDocument()
    // The valid row's detail is noise beside its status.
    expect(screen.queryByText(/Cloned successfully/)).not.toBeInTheDocument()
  })

  it('says "not locked" rather than leaving the commit blank', () => {
    // The normal state before intake closes — a blank cell reads as a fault. Scoped to the
    // row, because the footnote explaining it says the same words.
    withRouter(<SubmissionsTable page={page([row()])} challengeNames={NAMES}
      busy={false} query={{}} onQuery={vi.fn()} />)
    expect(screen.getByRole('row', { name: /Demo Team/ })).toHaveTextContent('not locked')
  })

  it('keeps the real backend total beside a bounded page (P5.7)', () => {
    // Said in rows, not pages: "1–1 of 240" answers the question an operator has, where
    // "page 1 of 240" would require them to multiply.
    withRouter(<SubmissionsTable page={page([row()], 240)} challengeNames={NAMES}
      busy={false} query={{}} onQuery={vi.fn()} />)
    expect(screen.getByTestId('pager')).toHaveTextContent('1–1 of 240')
  })

  it('asks the server to filter rather than filtering the page it was given', async () => {
    const onFilter = vi.fn()
    const user = userEvent.setup()
    withRouter(<SubmissionsTable page={page([row()])} challengeNames={NAMES}
      busy={false} query={{}} onQuery={onFilter} />)

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'PRIVATE')
    // Back to page 1: page 7 of the old result set means nothing in the new one.
    expect(onFilter).toHaveBeenCalledWith({ status: 'PRIVATE', page: 1 })
  })

  it('distinguishes "no entries" from "none match that filter"', () => {
    withRouter(<SubmissionsTable page={page([])} challengeNames={NAMES}
      busy={false} query={{}} onQuery={vi.fn()} />)
    expect(screen.getByText('No entries yet.')).toBeInTheDocument()
  })
})

const challenges: Challenge[] = [
  { challengeId: 8, name: 'Telemetry Triage' } as Challenge,
  { challengeId: 9, name: 'RealWorld Conduit' } as Challenge,
]

describe('starting a run', () => {
  const props = { challenges, existing: [], busy: false, failure: null, onStart: vi.fn() }

  it('will not start without a cohort, because that is what scopes the ranking', () => {
    render(<StartRunPanel {...props} />)
    expect(screen.getByRole('button', { name: /Start run 1/ })).toBeDisabled()
  })

  it('starts with every challenge when none is ticked', async () => {
    const onStart = vi.fn()
    const user = userEvent.setup()
    render(<StartRunPanel {...props} onStart={onStart} />)

    await user.type(screen.getByLabelText(/Cohort/), 'oct-2026')
    await user.click(screen.getByRole('button', { name: /Start run 1/ }))

    expect(onStart).toHaveBeenCalledWith({
      cohortKey: 'oct-2026', challengeIds: [], runIndex: 1,
    })
  })

  it('scopes to the ticked challenges', async () => {
    const onStart = vi.fn()
    const user = userEvent.setup()
    render(<StartRunPanel {...props} onStart={onStart} />)

    await user.type(screen.getByLabelText(/Cohort/), 'oct-2026')
    await user.click(screen.getByRole('checkbox', { name: 'RealWorld Conduit' }))
    await user.click(screen.getByRole('button', { name: /Start run 1/ }))

    expect(onStart).toHaveBeenCalledWith({
      cohortKey: 'oct-2026', challengeIds: [9], runIndex: 1,
    })
  })

  it('says run 2 is the second measurement, not a retry', () => {
    render(<StartRunPanel {...props} />)
    expect(screen.getByText(/not a retry/)).toBeInTheDocument()
  })

  it('warns that this spends money BEFORE the click, not after', () => {
    render(<StartRunPanel {...props} />)
    expect(screen.getByText(/costs model calls and takes hours/)).toBeInTheDocument()
  })

  it('surfaces a refusal from the server', () => {
    render(<StartRunPanel {...props}
      failure="Cohort 'demo' already has run 1 (COMPLETED)." />)
    expect(screen.getByRole('alert')).toHaveTextContent(/already has run 1/)
  })

  it('warns that an existing cohort and run will be CONTINUED, not replaced', async () => {
    // Nothing refuses this: the orchestrator reuses the run on purpose, for resume. Correct for
    // a resume and silent for a typo, so the warning is the only thing standing between a
    // mistyped cohort key and a merge into somebody else's run.
    const user = userEvent.setup()
    render(<StartRunPanel {...props} existing={[{ cohortKey: 'oct-2026', runIndex: 1 }]} />)

    await user.type(screen.getByLabelText(/Cohort/), 'oct-2026')

    expect(screen.getByTestId('run-collision')).toHaveTextContent(/already has run 1/)
    expect(screen.getByTestId('run-collision')).toHaveTextContent(/continue that run/)
    // The button says what it will actually do.
    expect(screen.getByRole('button', { name: 'Continue run 1' })).toBeEnabled()
  })

  it('says Start, not Continue, for a cohort that does not exist yet', async () => {
    const user = userEvent.setup()
    render(<StartRunPanel {...props} existing={[{ cohortKey: 'oct-2026', runIndex: 1 }]} />)

    await user.type(screen.getByLabelText(/Cohort/), 'nov-2026')
    expect(screen.queryByTestId('run-collision')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start run 1' })).toBeEnabled()
  })
})

describe('the filter survives the refetch it causes', () => {
  it('shows the status it was given, not a reset to All (E39)', () => {
    // Changing the filter blanks the page and unmounts this component. State held inside it was
    // lost, so the selects reset themselves the moment they were used and the list came back
    // unfiltered — which read as the filter not working at all.
    withRouter(<SubmissionsTable page={page([])} challengeNames={NAMES} busy={false}
      query={{ status: 'PENDING' }} onQuery={vi.fn()} />)

    expect(screen.getByLabelText('Filter by status')).toHaveValue('PENDING')
    expect(screen.getByText('No entries match that filter.')).toBeInTheDocument()
  })

  it('says "no entries" only when nothing is filtered', () => {
    withRouter(<SubmissionsTable page={page([])} challengeNames={NAMES} busy={false}
      query={{}} onQuery={vi.fn()} />)
    expect(screen.getByText('No entries yet.')).toBeInTheDocument()
  })
})

describe('sorting and paging (E40)', () => {
  const big = (over = {}) => ({
    items: [row()], total: 240, page: 3, pageSize: 25, truncated: false, ...over,
  }) as SubmissionPage

  it('asks the SERVER to sort, never reordering the page it was handed', async () => {
    // A client sorting 25 of 240 rows sorts the wrong subset and presents "the strongest entry"
    // when it is only the strongest of one page.
    const onQuery = vi.fn()
    const user = userEvent.setup()
    withRouter(<SubmissionsTable page={big()} challengeNames={NAMES} busy={false}
      query={{ page: 3 }} onQuery={onQuery} />)

    await user.click(screen.getByRole('button', { name: /Team/ }))
    // And back to page 1, because page 3 of the old order is a different set of rows.
    expect(onQuery).toHaveBeenCalledWith({ sort: 'team', page: 1 })
  })

  it('marks the sorted column for a screen reader, not only in bold', () => {
    withRouter(<SubmissionsTable page={big()} challengeNames={NAMES} busy={false}
      query={{ sort: 'team' }} onQuery={vi.fn()} />)

    expect(screen.getByRole('columnheader', { name: /Team/ }))
      .toHaveAttribute('aria-sort', 'other')
    expect(screen.getByRole('columnheader', { name: /Version/ }))
      .toHaveAttribute('aria-sort', 'none')
  })

  it('offers no sort on a column where ordering answers nothing', () => {
    // A repository URL orders alphabetically by host. A control that does nothing teaches an
    // operator that controls do nothing.
    withRouter(<SubmissionsTable page={big()} challengeNames={NAMES} busy={false}
      query={{}} onQuery={vi.fn()} />)

    expect(screen.getByRole('columnheader', { name: 'Repository' }))
      .not.toHaveAttribute('aria-sort')
  })

  it('pages forward and back, saying where you are in rows', async () => {
    const onQuery = vi.fn()
    const user = userEvent.setup()
    withRouter(<SubmissionsTable page={big()} challengeNames={NAMES} busy={false}
      query={{ page: 3 }} onQuery={onQuery} />)

    expect(screen.getByTestId('pager')).toHaveTextContent('51–51 of 240')
    expect(screen.getByTestId('pager')).toHaveTextContent('Page 3 of 10')

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onQuery).toHaveBeenCalledWith({ page: 4 })
  })

  it('hides the pager controls when everything fits on one page', () => {
    withRouter(<SubmissionsTable page={page([row()])} challengeNames={NAMES} busy={false}
      query={{}} onQuery={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
    // The count is still shown — it is the honest total, not a paging control.
    expect(screen.getByTestId('pager')).toHaveTextContent('1–1 of 1')
  })
})

describe('the pager describes what is on screen', () => {
  it('reports the rows actually rendered, not what a full page would hold', () => {
    // `page * pageSize` reads "1–25 of 240" for a page the server trimmed to three rows — the
    // table describing a list it is not showing.
    withRouter(<SubmissionsTable challengeNames={NAMES} busy={false} query={{}} onQuery={vi.fn()}
      page={{
        items: [row(), row({ submissionId: 79 }), row({ submissionId: 80 })],
        total: 240, page: 1, pageSize: 25, truncated: false,
      }} />)

    expect(screen.getByTestId('pager')).toHaveTextContent('1–3 of 240')
  })

  it('counts from the right offset on a later page', () => {
    withRouter(<SubmissionsTable challengeNames={NAMES} busy={false} query={{ page: 2 }}
      onQuery={vi.fn()}
      page={{ items: [row(), row({ submissionId: 79 })], total: 240, page: 2, pageSize: 25,
        truncated: false }} />)

    expect(screen.getByTestId('pager')).toHaveTextContent('26–27 of 240')
  })
})
