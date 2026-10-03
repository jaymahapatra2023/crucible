/**
 * Challenge split and cut-line band (E07-S05, E07-S06).
 *
 * Both panels exist so that a decision is made by a person with the relevant facts in front of
 * them. The tests therefore check what the panels SAY as much as what they show: an imbalance
 * presented without its medians, or a band presented without saying why each entry is there,
 * invites exactly the unexamined acceptance these stories are meant to prevent.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChallengeSplitPanel } from './ChallengeSplitPanel.js'
import { CutBandPanel } from './CutBandPanel.js'
import type { CutBandReport, RankedSubmission, SplitReport } from '../lib/scoringApi.js'

const splitRow = (overrides: Partial<SplitReport['byChallenge'][number]> = {}) => ({
  challengeId: 1, inShortlist: 12, shareOfShortlistPct: 48, ranked: 25,
  cohortSize: 25, belowFloor: false, medianComposite: 61.2,
  medianShortlisted: 74.5, bestRank: 1, ...overrides,
})

const split = (overrides: Partial<SplitReport> = {}): SplitReport => ({
  shortlistSize: 25, shortlisted: 25, advisory: null, imbalanceThresholdPct: 70,
  byChallenge: [splitRow(), splitRow({ challengeId: 2, inShortlist: 13, shareOfShortlistPct: 52 })],
  ...overrides,
})

const bandRow = (overrides: Partial<RankedSubmission> = {}): RankedSubmission => ({
  submission_id: 40, challenge_id: 1, team_name: 'Team Borderline', composite: 58.2,
  fidelity_raw: 55, fidelity_normalised: 57, cohort_size: 25,
  normalisation_method: 'PERCENTILE', missing_dimensions: [], weight_covered: 1,
  partial: false, rank_global: 24, rank_in_challenge: 12, tied: false,
  in_cut_band: true, advisory_decided: false,
  requires_review: true, review_reasons: ['IN_CUT_BAND'],
  review_reason_text: ['close to the cut line'],
  ...overrides,
})

const report = (overrides: Partial<CutBandReport> = {}): CutBandReport => ({
  cutLine: 25, bandSize: 3, band: [bandRow()], advisoryDecided: [], tiedAtCut: [],
  requiresReview: [], ...overrides,
})

const withRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('the challenge split (E07-S05)', () => {
  it('is ALWAYS shown, not only when something looks wrong (acceptance 1)', () => {
    render(<ChallengeSplitPanel split={split()} />)
    expect(screen.getByTestId('split-count-1')).toHaveTextContent('12')
    expect(screen.getByTestId('split-count-2')).toHaveTextContent('13')
  })

  it('shows the median composite per challenge alongside the counts (acceptance 3)', () => {
    render(<ChallengeSplitPanel split={split({
      byChallenge: [splitRow(), splitRow({
        challengeId: 2, medianComposite: 52.8, medianShortlisted: 66.3,
      })],
    })} />)
    // Both challenges' medians, so difficulty imbalance is distinguishable from talent.
    expect(screen.getByText('61.2')).toBeInTheDocument()
    expect(screen.getByText('52.8')).toBeInTheDocument()
    expect(screen.getByText('74.5')).toBeInTheDocument()
    expect(screen.getByText('66.3')).toBeInTheDocument()
  })

  it('raises the imbalance advisory when one challenge dominates (acceptance 2)', () => {
    render(<ChallengeSplitPanel split={split({
      advisory: 'Challenge 1 holds 88% of the shortlist, above the 70% advisory threshold.',
    })} />)
    expect(screen.getByTestId('split-advisory')).toHaveTextContent(/88% of the shortlist/)
  })

  it('shows NO advisory when the split is within tolerance', () => {
    render(<ChallengeSplitPanel split={split()} />)
    expect(screen.queryByTestId('split-advisory')).not.toBeInTheDocument()
  })

  it('marks a cohort that fell below the normalisation floor', () => {
    render(<ChallengeSplitPanel split={split({
      byChallenge: [splitRow({ cohortSize: 4, belowFloor: true })],
    })} />)
    expect(screen.getByText(/below floor/)).toBeInTheDocument()
  })

  it('renders a missing median as a dash rather than a zero', () => {
    render(<ChallengeSplitPanel split={split({
      byChallenge: [splitRow({ medianComposite: null, medianShortlisted: null })],
    })} />)
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('says how many have been ranked when fewer than the shortlist size', () => {
    render(<ChallengeSplitPanel split={split({ shortlisted: 8 })} />)
    expect(screen.getByText(/8 ranked so far/)).toBeInTheDocument()
  })
})

describe('the cut-line band (E07-S06)', () => {
  it('says every entry requires review (acceptance 2)', () => {
    withRouter(<CutBandPanel report={report()} runId={7} />)
    expect(screen.getByRole('heading', { name: /1 require review/ })).toBeInTheDocument()
  })

  it('says being listed is not a judgement', () => {
    withRouter(<CutBandPanel report={report()} runId={7} />)
    expect(screen.getByText(/not a judgement/)).toBeInTheDocument()
  })

  it('CALLS OUT a position that depends on the advisory dimension (acceptance 3)', () => {
    const row = bandRow({
      advisory_decided: true,
      review_reasons: ['ADVISORY_DECIDED'],
      review_reason_text: [
        'position depends on the advisory inventiveness dimension, which must not decide it alone',
      ],
    })
    withRouter(<CutBandPanel report={report({ band: [row], advisoryDecided: [row] })} runId={7} />)

    expect(screen.getByTestId('advisory-decided'))
      .toHaveTextContent(/must not decide this on its own/)
    // Both the call-out banner and the row's own reason say it, which is the point: a reviewer
    // scanning the table sees it without having read the banner.
    expect(screen.getAllByText(/position depends on the advisory inventiveness dimension/))
      .toHaveLength(2)
  })

  it('does not raise the advisory call-out when no position turns on it', () => {
    withRouter(<CutBandPanel report={report()} runId={7} />)
    expect(screen.queryByTestId('advisory-decided')).not.toBeInTheDocument()
  })

  it('says WHY each entry needs a look, rather than just listing it', () => {
    withRouter(<CutBandPanel report={report({
      band: [bandRow({
        tied: true,
        review_reason_text: [
          'close to the cut line',
          'tied composite — the order between ties is arbitrary',
          'a whole dimension could not be scored',
        ],
      })],
    })} runId={7} />)

    const reasons = screen.getByText(/the order between ties is arbitrary/)
    expect(reasons).toHaveTextContent(/a whole dimension could not be scored/)
  })

  it('renders the reasons the API worded, not a second copy of the vocabulary', () => {
    withRouter(<CutBandPanel report={report({
      band: [bandRow({
        review_reason_text: ['cohort too small to normalise; scored absolutely'],
      })],
    })} runId={7} />)
    expect(screen.getByText(/cohort too small to normalise/)).toBeInTheDocument()
  })

  it('falls back to "close to the line" rather than an empty cell', () => {
    withRouter(<CutBandPanel report={report({
      band: [bandRow({ review_reasons: [], review_reason_text: [] })],
    })} runId={7} />)
    expect(screen.getByText('close to the line')).toBeInTheDocument()
  })

  it('links each entry to its evidence', () => {
    withRouter(<CutBandPanel report={report()} runId={7} />)
    expect(screen.getByRole('link', { name: 'Team Borderline' }))
      .toHaveAttribute('href', '/scoring/runs/7/submissions/40')
  })

  it('explains an empty band rather than rendering an empty table', () => {
    withRouter(<CutBandPanel report={report({ band: [] })} runId={7} />)
    expect(screen.getByText(/No submission falls within 3 places of rank 25/))
      .toBeInTheDocument()
  })
})
