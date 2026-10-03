/**
 * The go/no-go banner (E11-S03).
 *
 * The state worth testing hardest is the quiet one: a system that has never been calibrated
 * looks exactly like a calibrated one until somebody presses the button, so the banner has to
 * make the difference impossible to miss — and has to say what IS still available, or an
 * operator reads "disabled" as "broken".
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GateBanner } from './GateBanner.js'
import type { GateResponse } from '../lib/calibrationApi.js'

const status = (decision: 'GO' | 'NO_GO'): GateResponse['status'] => ({
  decision_id: 1, decision, rationale: 'Two placements were wrong by five positions.',
  decided_by: 'chair@test.local', decided_at: '2026-03-01T10:00:00.000Z',
  report_id: 1, golden_set_id: 1, rank_correlation: 0.62,
  fallback_plan: 'Fall back to fully human judging; the system gathers evidence only.',
})

describe('when the gate was passed', () => {
  it('says so, with who decided and the correlation', () => {
    render(<GateBanner gate={{ status: status('GO'), rankingPermitted: true, note: null }} />)
    const banner = screen.getByTestId('gate-ok')
    expect(banner).toHaveTextContent('chair@test.local')
    expect(banner).toHaveTextContent('0.62')
  })
})

describe('when the gate was FAILED', () => {
  const gate: GateResponse = {
    status: status('NO_GO'), rankingPermitted: false, note: null,
  }

  it('says ranking is disabled and why', () => {
    render(<GateBanner gate={gate} />)
    const banner = screen.getByTestId('gate-no-go')
    expect(banner).toHaveTextContent('Ranking is disabled')
    expect(banner).toHaveTextContent('Two placements were wrong')
  })

  it('quotes the FALLBACK plan recorded before the decision', () => {
    render(<GateBanner gate={gate} />)
    expect(screen.getByTestId('gate-no-go')).toHaveTextContent(/fully human judging/)
  })

  it('says what REMAINS available, so "disabled" is not read as "broken"', () => {
    render(<GateBanner gate={gate} />)
    expect(screen.getByTestId('gate-no-go'))
      .toHaveTextContent(/can still gather evidence for people to judge from/)
  })
})

describe('when no decision has been taken', () => {
  const gate: GateResponse = {
    status: null, rankingPermitted: false,
    note: 'No go/no-go decision has been recorded. Ranking is refused until one is.',
  }

  it('does NOT present silence as a pass', () => {
    render(<GateBanner gate={gate} />)
    expect(screen.getByTestId('gate-undecided'))
      .toHaveTextContent('This system has not been calibrated')
    expect(screen.queryByTestId('gate-ok')).not.toBeInTheDocument()
  })

  it('carries the explanation the API sent rather than inventing one', () => {
    render(<GateBanner gate={gate} />)
    expect(screen.getByTestId('gate-undecided')).toHaveTextContent(/refused until one is/)
  })

  it('still says evidence gathering is available', () => {
    render(<GateBanner gate={gate} />)
    expect(screen.getByTestId('gate-undecided'))
      .toHaveTextContent(/Evidence gathering remains available/)
  })
})

describe('a gate whose settings have since moved (E14-S03)', () => {
  const passedUnder = (coversCurrentConfig: boolean) => ({
    rankingPermitted: true,
    note: null,
    status: {
      decision_id: 1, decision: 'GO' as const,
      rationale: 'Rank correlation was strong and the disagreements were explicable.',
      decided_by: 'organiser@test.local', decided_at: '2026-09-01T09:00:00Z',
      report_id: 1, golden_set_id: 1, rank_correlation: 0.91,
      fallback_plan: 'Fully human judging.',
      coversCurrentConfig,
      configNote: coversCurrentConfig
        ? 'The settings now in force are the ones this decision was measured under.'
        : 'These runs were NOT executed alike: scoring.cut_line differed. This verdict was '
          + 'measured under different settings and does not vouch for a run under the current ones.',
    },
  })

  it('warns that a passed gate no longer covers the current settings', () => {
    // The quiet failure worth being loud about: the verdict still reads GO, and it was measured
    // on settings that no longer apply.
    render(<GateBanner gate={passedUnder(false)} />)
    expect(screen.getByTestId('gate-stale')).toBeInTheDocument()
    expect(screen.getByText(/Settings have changed since/i)).toBeInTheDocument()
    expect(screen.getByText(/does not vouch for a run under the current ones/i))
      .toBeInTheDocument()
  })

  it('stays quiet when the settings are the ones it was measured under', () => {
    render(<GateBanner gate={passedUnder(true)} />)
    expect(screen.getByTestId('gate-ok')).toBeInTheDocument()
    expect(screen.queryByText(/Settings have changed since/i)).not.toBeInTheDocument()
  })

  it('says nothing about drift for a gate recorded before pinning existed', () => {
    // `coversCurrentConfig` absent means unknown. Claiming either way would be inventing a fact.
    const unknown = passedUnder(true)
    const status = { ...unknown.status }
    delete (status as { coversCurrentConfig?: boolean | null }).coversCurrentConfig
    render(<GateBanner gate={{ ...unknown, status }} />)
    expect(screen.getByTestId('gate-ok')).toBeInTheDocument()
    expect(screen.queryByText(/Settings have changed since/i)).not.toBeInTheDocument()
  })

  it('states plainly, and quietly, when the configuration was never recorded', () => {
    // A third state, not a collapse of the other two. Warning loudly here would cry wolf on
    // every decision taken before pinning existed; claiming coverage would invent a fact.
    const status = {
      ...passedUnder(true).status,
      coversCurrentConfig: null,
      configNote: 'This decision was taken before the configuration behind a gate was recorded, '
        + 'so which settings it was measured under is not known.',
    }
    render(<GateBanner gate={{ ...passedUnder(true), status }} />)

    expect(screen.getByTestId('gate-ok')).toBeInTheDocument()
    expect(screen.getByText(/is not known/i)).toBeInTheDocument()
    expect(screen.queryByText(/Settings have changed since/i)).not.toBeInTheDocument()
  })
})
