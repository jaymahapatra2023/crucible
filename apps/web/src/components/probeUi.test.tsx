/**
 * What a reviewer reads about the build (E05-S05).
 *
 * The grade is a word, not a colour, and the sentence beside it has to be readable by somebody
 * who has never seen the grade vocabulary. The case that matters most is the one where the
 * system judged WHOSE fault a stopped container was: a reviewer has to be able to see that a
 * judgement was made, and what it cost, or they cannot overrule it.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProbeSummary } from './ProbeSummary.js'

const probe = (over: Record<string, unknown> = {}) => ({
  probe_id: 1, outcome: 'RUNS', runs_grade: 'RUNS',
  grade_reason: 'Built and stayed up for the settle period (exit code 0).',
  log_truncated: false, ...over,
} as NonNullable<Parameters<typeof ProbeSummary>[0]['probe']>)

describe('the build summary', () => {
  it('says a sandbox-blocked entry was scored 3 of 4, not 0', () => {
    render(<ProbeSummary provenance={[]} probe={probe({
      outcome: 'SANDBOX_BLOCKED', runs_grade: 'BLOCKED_BY_SANDBOX',
      grade_reason: 'The application started but stopped because it tried to reach the network. '
        + 'Evidence: npm error code EAI_AGAIN',
    })} />)

    expect(screen.getByTestId('probe-grade')).toHaveTextContent('BLOCKED_BY_SANDBOX')
    expect(screen.getByText(/Scored 3 of 4 rather than 0/)).toBeInTheDocument()
    // And the evidence itself, so the judgement can be checked rather than taken on trust.
    expect(screen.getByText(/EAI_AGAIN/)).toBeInTheDocument()
  })

  it('still reads plainly for the ordinary grades', () => {
    render(<ProbeSummary provenance={[]} probe={probe()} />)
    expect(screen.getByText(/Built and stayed up\./)).toBeInTheDocument()
  })

  it('says an unprobed submission was EXCLUDED, never scored zero', () => {
    render(<ProbeSummary provenance={[]} probe={null} />)
    expect(screen.getByText(/left out of its composite rather than scored zero/))
      .toBeInTheDocument()
  })

  it('falls back to the stored reason for a grade it has no sentence for', () => {
    render(<ProbeSummary provenance={[]} probe={probe({
      runs_grade: 'SOMETHING_NEW', grade_reason: 'A reason written by the prober.',
    })} />)
    // Two places, so the assertion is on the fallback in the headline specifically.
    expect(screen.getAllByText(/A reason written by the prober\./).length).toBeGreaterThan(0)
  })
})
