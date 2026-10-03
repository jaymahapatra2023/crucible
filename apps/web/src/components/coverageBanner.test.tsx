/**
 * Whether a ranked field was evidenced evenly (E15-S04).
 *
 * The banner is silent in two of three states on purpose. A field where nobody was described is
 * consistent and therefore fair; one where everybody was is complete. Warning on either would
 * train a reviewer to scroll past the warning that matters.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoverageBanner } from './CoverageBanner.js'
import type { DiscoveryCoverage } from '../lib/scoringApi.js'

const coverage = (over: Partial<DiscoveryCoverage> = {}): DiscoveryCoverage => ({
  submissions: 50, discovered: 38, completed: 38, undiscovered: 12,
  state: 'PARTIAL', uneven: true,
  note: 'Only 38 of 50 submissions were described before scoring. The other 12 were judged on '
    + 'less context than their competitors, against the same rubric and in the same ranking. '
    + 'Discover the remaining 12 and re-score, or treat this ranking as provisional.',
  ...over,
})

describe('a field evidenced unevenly', () => {
  it('says plainly that the field was not evidenced evenly', () => {
    render(<CoverageBanner coverage={coverage()} />)
    expect(screen.getByTestId('coverage-uneven')).toBeInTheDocument()
    expect(screen.getByText(/not evidenced evenly/i)).toBeInTheDocument()
  })

  it('names how many were judged on less context than their competitors', () => {
    render(<CoverageBanner coverage={coverage()} />)
    expect(screen.getByText(/judged on less context than their competitors/i))
      .toBeInTheDocument()
  })

  it('is announced, because a reviewer who misses it ranks on unequal evidence', () => {
    render(<CoverageBanner coverage={coverage()} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})

describe('a field that needs no warning', () => {
  it('is silent when nobody was described — that is consistent, and fair', () => {
    const { container } = render(<CoverageBanner
      coverage={coverage({ state: 'NONE', uneven: false, discovered: 0, undiscovered: 50 })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is silent when everybody was described', () => {
    const { container } = render(<CoverageBanner
      coverage={coverage({ state: 'COMPLETE', uneven: false, discovered: 50, undiscovered: 0 })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is silent for a ranking computed before coverage was reported', () => {
    // Absent means unknown. Claiming either way would invent a fact.
    const { container } = render(<CoverageBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})
