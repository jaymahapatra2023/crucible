/**
 * Score display (E06-S02, E06-S04, E06-S05; P5.1, P5.2).
 *
 * The scoring pipeline works hard to keep "scored zero" and "could not be scored" apart. These
 * tests exist because the UI is where that distinction is most easily destroyed: a blank cell,
 * a dash, or a helpfully-defaulted 0 undoes all of it, and a reviewer reads the number.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScoreCard, ScoreBadge, EvidenceList } from './ScoreCard.js'
import { MetricInputsPanel } from './MetricInputs.js'
import { OriginalityPanel } from './OriginalityPanel.js'
import type { CriterionScore, MetricInputs, OriginalityAssessment } from '../lib/scoringApi.js'

const score = (overrides: Partial<CriterionScore> = {}): CriterionScore => ({
  id: 1, criterion_id: 1, dimension: 'ENGINEERING_QUALITY',
  raw_score: 3, non_score: null, confidence: 80,
  rationale: 'A retry loop with backoff is present.',
  anchor_matched: 'Retries with backoff on the main path.',
  evidence: [{ path: 'src/retry.ts', lineStart: 1, lineEnd: 12, excerpt: 'withRetry' }],
  context_bytes: 4000, context_truncated: false, files_searched: 12,
  rubric_version: 2, model: 'claude-sonnet-5',
  ...overrides,
})

describe('a scored criterion', () => {
  it('shows the score out of four, with its anchor and rationale', () => {
    render(<ScoreCard score={score()} />)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/Retries with backoff on the main path/)).toBeInTheDocument()
    expect(screen.getByText(/A retry loop with backoff is present/)).toBeInTheDocument()
  })

  it('names the rubric version the score was judged by (acceptance 4)', () => {
    render(<ScoreCard score={score()} />)
    expect(screen.getByText(/Rubric v2/)).toBeInTheDocument()
  })

  it('shows a genuine zero as a zero', () => {
    render(<ScoreCard score={score({ raw_score: 0, anchor_matched: 'No evidence of retries.' })} />)
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.queryByText(/Not enough evidence/)).not.toBeInTheDocument()
  })
})

describe('a criterion that could NOT be scored', () => {
  it('says so in words — never as a zero and never as a blank', () => {
    render(<ScoreCard score={score({ raw_score: null, non_score: 'INSUFFICIENT_EVIDENCE' })} />)
    expect(screen.getByText(/Not enough evidence to score/)).toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('explains that it was EXCLUDED from the average, not counted as zero', () => {
    render(<ScoreCard score={score({ raw_score: null, non_score: 'INSUFFICIENT_EVIDENCE' })} />)
    expect(screen.getByText(/excluded from the average rather than counted as zero/))
      .toBeInTheDocument()
  })

  it('distinguishes a failed call from a judgement about the work', () => {
    render(<ScoreCard score={score({ raw_score: null, non_score: 'SCORING_FAILED' })} />)
    expect(screen.getByText(/not an assessment of the work/)).toBeInTheDocument()
    expect(screen.getByText(/says nothing about the submission/)).toBeInTheDocument()
  })

  it('does not offer a confidence figure for something it did not judge', () => {
    render(<ScoreCard score={score({ raw_score: null, non_score: 'SCORING_FAILED' })} />)
    expect(screen.queryByText(/confidence/)).not.toBeInTheDocument()
  })

  it('renders a non-score code it has no wording for, rather than nothing', () => {
    render(<ScoreBadge score={null} nonScore="SOMETHING_NEW" />)
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument()
  })
})

describe('evidence', () => {
  it('cites the file and line range', () => {
    render(<EvidenceList evidence={[
      { path: 'src/retry.ts', lineStart: 4, lineEnd: 20, excerpt: 'const x = 1' },
    ]} />)
    expect(screen.getByText('src/retry.ts:4–20')).toBeInTheDocument()
  })

  it('renders nothing when there is none, rather than an empty box', () => {
    const { container } = render(<EvidenceList evidence={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('WARNS when the context budget was truncated', () => {
    render(<ScoreCard score={score({ context_truncated: true })} />)
    expect(screen.getByText(/context budget truncated/)).toBeInTheDocument()
  })
})

describe('the metric inputs (E06-S04 acceptance 3)', () => {
  const inputs = (overrides: Partial<MetricInputs> = {}): MetricInputs => ({
    summary: '12 files analysed.',
    metrics: {
      codeLines: 1200, commentLines: 80, maxFileLines: 310,
      hasTests: true, testFileCount: 6, hasCi: false, hasDockerfile: true,
      dependencyCount: 14, languages: ['typescript'],
    },
    filesAnalysed: 12, filesTotal: 20, budgetTruncated: false, commitSha: 'abcdef0123456789',
    ...overrides,
  })

  it('shows the measurements the score was computed from', () => {
    render(<MetricInputsPanel inputs={inputs()} />)
    expect(screen.getByText('1200')).toBeInTheDocument()
    expect(screen.getByText('12 of 20')).toBeInTheDocument()
    expect(screen.getByText('6 files')).toBeInTheDocument()
  })

  it('says size is context rather than quality', () => {
    render(<MetricInputsPanel inputs={inputs()} />)
    expect(screen.getByText(/Size is context, not quality/)).toBeInTheDocument()
  })

  it('reports an absent signal as "none found", not as a blank', () => {
    render(<MetricInputsPanel inputs={inputs()} />)
    expect(screen.getAllByText('none found').length).toBeGreaterThan(0)
  })

  it('WARNS when the scan did not read the whole repository', () => {
    render(<MetricInputsPanel inputs={inputs({ budgetTruncated: true })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/did not read the whole repository/)
  })

  it('explains itself when the scan is gone, rather than rendering an empty panel', () => {
    render(<MetricInputsPanel inputs={null} />)
    expect(screen.getByText(/no longer available/)).toBeInTheDocument()
  })
})

describe('the advisory originality signal (E06-S05 acceptance 2)', () => {
  const originality = (overrides: Partial<OriginalityAssessment> = {}): OriginalityAssessment => ({
    level: 2, non_score: null, confidence: 60,
    rationale: 'The domain logic is the team’s own work.',
    observations: [], boilerplate_share_pct: 62,
    scaffold_lines: 300, substantive_lines: 180,
    templates: [{ id: 'vite-starter', name: 'Vite starter template', matchedOn: 'vite.config.ts' }],
    provenance_flags: [],
    ...overrides,
  })

  it('labels the dimension ADVISORY on the page, not just in the schema', () => {
    render(<OriginalityPanel originality={originality()} />)
    expect(screen.getByText('ADVISORY')).toBeInTheDocument()
  })

  it('says it can never be the sole reason a submission falls below the cut', () => {
    render(<OriginalityPanel originality={originality()} />)
    expect(screen.getByText(/never be the sole reason/)).toBeInTheDocument()
  })

  it('shows the measurements behind the level', () => {
    render(<OriginalityPanel originality={originality()} />)
    expect(screen.getByText('62.0%')).toBeInTheDocument()
    expect(screen.getByText('180')).toBeInTheDocument()
    expect(screen.getByText(/Vite starter template/)).toBeInTheDocument()
  })

  it('offers the innocent reading of a high scaffold share', () => {
    render(<OriginalityPanel originality={originality({ boilerplate_share_pct: 91 })} />)
    expect(screen.getByText(/not a criticism/)).toBeInTheDocument()
  })

  it('presents the measurements as context, not as the score (E35)', () => {
    // The dimension used to ask how much of the work was the team's own, and these numbers were
    // the finding. They are now the bound on a different question, and a reviewer who reads the
    // percentage as the verdict is reading the old dimension.
    render(<OriginalityPanel originality={originality({ boilerplate_share_pct: 91 })} />)

    expect(screen.getByText(/how the repository was assembled, not how good the idea is/))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Inventiveness/ })).toBeInTheDocument()
    expect(screen.getByText(/not how much of the code the team wrote themselves/))
      .toBeInTheDocument()
  })

  it('shows provenance flags as observations for a person to check', () => {
    render(<OriginalityPanel originality={originality({
      provenance_flags: [{ code: 'NO_HISTORY', message: 'No readable git history.' }],
    })} />)
    expect(screen.getByText('No readable git history.')).toBeInTheDocument()
  })

  it('says the dimension was LEFT OUT when it did not run, not scored zero', () => {
    render(<OriginalityPanel originality={null} />)
    expect(screen.getByText(/left out of the composite rather than scored zero/))
      .toBeInTheDocument()
  })
})
