/**
 * Citation verdicts as a reviewer sees them (E13-S04, P5.5).
 *
 * The distinction a reviewer needs in one glance: a quotation checked against the commit the
 * team submitted, versus one we could not check. Getting that wrong in either direction is
 * costly — implying doubt about a team when the limit was ours, or implying we checked
 * something we did not.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScoreCard } from './ScoreCard.js'
import type { CriterionScore, EvidenceItem } from '../lib/scoringApi.js'

const evidence = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  path: 'src/retry.ts', lineStart: 1, lineEnd: 12,
  excerpt: 'export async function withRetry', ...over,
})

const score = (evidenceItems: EvidenceItem[]): CriterionScore => ({
  id: 1,
  criterionId: 'c1',
  criterionName: 'Handles failure without losing work',
  dimension: 'ENGINEERING_QUALITY',
  rawScore: 3,
  nonScore: null,
  confidence: 90,
  rationale: 'The retry loop is present and applies backoff.',
  anchorMatched: 'Retries with backoff on the main path.',
  evidence: evidenceItems,
  contextTruncated: false,
  filesSearched: 4,
} as unknown as CriterionScore)

describe('a checked citation', () => {
  it('says it was checked against the source', () => {
    render(<ScoreCard score={score([evidence({ verdict: 'VERIFIED' })])} />)
    expect(screen.getByText(/checked against the source/i)).toBeInTheDocument()
  })

  it('carries the reason as a title, so the detail is available without crowding', () => {
    render(<ScoreCard score={score([
      evidence({ verdict: 'VERIFIED', verdictReason: 'The quoted text is at src/retry.ts:1.' }),
    ])} />)
    expect(screen.getByText(/checked against the source/i))
      .toHaveAttribute('title', 'The quoted text is at src/retry.ts:1.')
  })
})

describe('a citation that could not be checked', () => {
  it('words it as a limit of our reading, never as doubt about the team', () => {
    render(<ScoreCard score={score([evidence({ verdict: 'UNVERIFIABLE' })])} />)
    const label = screen.getByText(/outside what the scan read/i)
    expect(label).toBeInTheDocument()
    // Nothing on screen may suggest the team invented it.
    expect(document.body.textContent).not.toMatch(/fabricat|invent|false|suspicious/i)
  })
})

describe('a score taken before checking existed', () => {
  it('claims nothing rather than implying a check happened', () => {
    // Silence is correct here. Showing "checked" for an unchecked citation would be the same
    // class of dishonesty this whole feature exists to prevent.
    render(<ScoreCard score={score([evidence()])} />)
    expect(screen.queryByText(/checked against the source/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/outside what the scan read/i)).not.toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('states each verdict in words, not by colour alone (P5.5)', () => {
    render(<ScoreCard score={score([
      evidence({ verdict: 'VERIFIED' }),
      evidence({ path: 'src/other.ts', verdict: 'UNVERIFIABLE' }),
    ])} />)
    expect(screen.getByText(/checked against the source/i)).toBeInTheDocument()
    expect(screen.getByText(/outside what the scan read/i)).toBeInTheDocument()
  })
})
