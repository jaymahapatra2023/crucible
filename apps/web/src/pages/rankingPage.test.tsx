/**
 * The ranking page (E07-S03 … E07-S06; P5.1, P5.3).
 *
 * The page renders positions that decide who a human looks at. The properties that matter:
 * a position computed from partial evidence must say so, a ranking that no longer matches the
 * scores must say so, and nothing on the page may present a submission as selected — that is a
 * decision the page is deliberately incapable of expressing.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ApiClientError } from '../lib/apiClient.js'
import type {
  CutBandReport, Ranking, RankedSubmission, SplitReport,
} from '../lib/scoringApi.js'

const getRanking = vi.fn()
const getSplit = vi.fn()
const getBorderline = vi.fn()
const getGate = vi.fn()
vi.mock('../lib/scoringApi.js', () => ({
  getRanking: (id: number) => getRanking(id),
  getSplit: (id: number) => getSplit(id),
  getBorderline: (id: number) => getBorderline(id),
}))
vi.mock('../lib/calibrationApi.js', () => ({ getGate: () => getGate() }))

const { RankingPage } = await import('./RankingPage.js')

function entry(overrides: Partial<RankedSubmission> = {}): RankedSubmission {
  return {
    submission_id: 11, challenge_id: 1, team_name: 'Team Alpha', composite: 82.5,
    fidelity_raw: 75, fidelity_normalised: 88, cohort_size: 20,
    normalisation_method: 'PERCENTILE', missing_dimensions: [],
    weight_covered: 1, partial: false,
    rank_global: 1, rank_in_challenge: 1, tied: false,
    in_cut_band: false, advisory_decided: false,
    requires_review: false, review_reasons: [], review_reason_text: [],
    ...overrides,
  }
}

const ranking = (overrides: Partial<Ranking> = {}): Ranking => ({
  ranked: [entry()],
  snapshot: {
    scores_counted: 10, submissions: 1, cut_line_used: 25, band_size_used: 3,
    min_cohort_size: 15, computed_by: 'organiser@test.local',
    computed_at: '2026-02-01T10:00:00.000Z',
  },
  stale: false, fallbackChallenges: [], partialCount: 0, cutLine: 25, bandSize: 3,
  ...overrides,
})

const split = (overrides: Partial<SplitReport> = {}): SplitReport => ({
  shortlistSize: 25, shortlisted: 1, advisory: null, imbalanceThresholdPct: 70,
  byChallenge: [{
    challengeId: 1, inShortlist: 1, shareOfShortlistPct: 100, ranked: 1,
    // Deliberately distinct from any composite in the ranking fixture, so an assertion about
    // the ranking table cannot be satisfied by the split panel instead.
    cohortSize: 20, belowFloor: false, medianComposite: 70.1,
    medianShortlisted: 70.2, bestRank: 1,
  }],
  ...overrides,
})

const band = (overrides: Partial<CutBandReport> = {}): CutBandReport => ({
  cutLine: 25, bandSize: 3, band: [], advisoryDecided: [], tiedAtCut: [],
  requiresReview: [], ...overrides,
})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/scoring/runs/7']}>
      <Routes>
        <Route path="/scoring/runs/:runId" element={<RankingPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  getRanking.mockReset().mockResolvedValue(ranking())
  getSplit.mockReset().mockResolvedValue(split())
  getBorderline.mockReset().mockResolvedValue(band())
  getGate.mockReset().mockResolvedValue({
    status: null, rankingPermitted: true, note: null,
  })
})

describe('the ordering', () => {
  it('lists submissions with their rank and composite', async () => {
    getRanking.mockResolvedValue(ranking({
      ranked: [entry(), entry({ submission_id: 12, rank_global: 2, composite: 61.25 })],
    }))
    renderPage()

    expect(await screen.findByText('82.5')).toBeInTheDocument()
    expect(screen.getByText('61.3')).toBeInTheDocument()
  })

  it('says plainly that it decides nothing (P0 constraint 1)', async () => {
    renderPage()
    expect(await screen.findByText(/Nothing here selects or eliminates anyone/))
      .toBeInTheDocument()
  })

  it('offers no control that could mark a submission as selected', async () => {
    renderPage()
    await screen.findByText('82.5')
    expect(screen.queryByRole('button', { name: /select|shortlist|eliminate/i }))
      .not.toBeInTheDocument()
  })

  it('MARKS a tie rather than breaking it silently', async () => {
    getRanking.mockResolvedValue(ranking({
      ranked: [entry({ tied: true }), entry({ submission_id: 12, rank_global: 2, tied: true })],
    }))
    renderPage()
    expect(await screen.findAllByText(/\(tied\)/)).toHaveLength(2)
  })
})

describe('honesty about the evidence behind a position (P5.1)', () => {
  it('shows the RAW fidelity alongside the normalised one, for appeals', async () => {
    renderPage()
    expect(await screen.findByText(/88\.0/)).toBeInTheDocument()
    expect(screen.getByText(/raw 75\.0/)).toBeInTheDocument()
  })

  it('says "not scored" rather than showing a fidelity of zero', async () => {
    getRanking.mockResolvedValue(ranking({
      ranked: [entry({ fidelity_normalised: null, fidelity_raw: null })],
    }))
    renderPage()
    expect(await screen.findByText('not scored')).toBeInTheDocument()
  })

  it('NAMES the dimensions that could not be scored', async () => {
    getRanking.mockResolvedValue(ranking({
      ranked: [entry({ missing_dimensions: ['RUNS'], weight_covered: 0.85, partial: true })],
      partialCount: 1,
    }))
    renderPage()
    expect(await screen.findByText(/no runs/)).toBeInTheDocument()
    expect(screen.getByText('85%')).toBeInTheDocument()
  })

  it('WARNS when the ranking no longer matches the scores (P5.1)', async () => {
    getRanking.mockResolvedValue(ranking({ stale: true }))
    renderPage()
    expect(await screen.findByTestId('stale-warning'))
      .toHaveTextContent(/Recompute the ranking before acting on it/)
  })

  it('does NOT warn about staleness when the ranking is current', async () => {
    renderPage()
    await screen.findByText('82.5')
    expect(screen.queryByTestId('stale-warning')).not.toBeInTheDocument()
  })

  it('lets a reviewer narrow to just the partial ones', async () => {
    getRanking.mockResolvedValue(ranking({
      ranked: [
        entry(),
        entry({ submission_id: 12, rank_global: 2, composite: 40, partial: true }),
      ],
      partialCount: 1,
    }))
    renderPage()
    await screen.findByText('82.5')

    await userEvent.click(screen.getByLabelText(/show only these/))
    await waitFor(() => expect(screen.queryByText('82.5')).not.toBeInTheDocument())
    expect(screen.getByText('40.0')).toBeInTheDocument()
  })

  it('WARNS when a cohort was too small to normalise (E07-S03)', async () => {
    getRanking.mockResolvedValue(ranking({ fallbackChallenges: [3] }))
    renderPage()
    expect(await screen.findByText(/too few submissions to normalise/)).toBeInTheDocument()
  })

  it('offers the export, which carries the same caveats (E07-S03 acceptance 3)', async () => {
    renderPage()
    // A button, not a link: the export endpoint needs the session token, which a browser
    // navigation would not send. See `DownloadButton`.
    expect(await screen.findByTestId('export-ranking')).toHaveTextContent('Export CSV')
  })
})

describe('the calibration gate (E11-S03)', () => {
  it('WARNS on this page too when the system has not been calibrated', async () => {
    getGate.mockResolvedValue({
      status: null, rankingPermitted: false,
      note: 'No go/no-go decision has been recorded.',
    })
    renderPage()
    // The ranking screen shows positions, so it must say whether they may be acted on.
    expect(await screen.findByTestId('gate-undecided')).toBeInTheDocument()
  })

  it('shows no warning when the gate was passed', async () => {
    getGate.mockResolvedValue({
      status: {
        decision_id: 1, decision: 'GO', rationale: 'r', decided_by: 'chair@test.local',
        decided_at: '2026-03-01T00:00:00Z', report_id: 1, golden_set_id: 1,
        rank_correlation: 0.9, fallback_plan: 'f',
      },
      rankingPermitted: true, note: null,
    })
    renderPage()
    await screen.findByText('82.5')
    expect(screen.queryByTestId('gate-undecided')).not.toBeInTheDocument()
  })
})

describe('when things go wrong', () => {
  it('shows a retryable error rather than an empty table', async () => {
    getRanking.mockRejectedValue(new ApiClientError('NOT_FOUND', 'Run not found', 404))
    renderPage()
    expect(await screen.findByText(/Ranking could not be loaded/)).toBeInTheDocument()
    expect(screen.getByText('Run not found')).toBeInTheDocument()
  })

  it('explains an uncomputed ranking rather than showing an empty table', async () => {
    getRanking.mockResolvedValue(ranking({ ranked: [], partialCount: 0 }))
    getSplit.mockResolvedValue(split({ shortlisted: 0, byChallenge: [] }))
    renderPage()
    expect(await screen.findByText(/Nothing to rank/)).toBeInTheDocument()
  })
})
