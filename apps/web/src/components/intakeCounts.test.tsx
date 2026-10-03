import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IntakeCounts } from './IntakeCounts.js'
import type { IntakeDashboard } from '../lib/intakeApi.js'

const dashboard = (totals: Partial<IntakeDashboard['totals']> = {}): IntakeDashboard => ({
  byChallenge: [],
  totals: { total: 0, valid: 0, pending: 0, unreachable: 0, private: 0, rejected: 0, ...totals },
  failing: [],
})

describe('IntakeCounts (E03-S05 acceptance 1, P5.7)', () => {
  it('shows every status the organiser needs to chase', () => {
    render(<IntakeCounts dashboard={dashboard({
      total: 48, valid: 44, pending: 1, private: 2, unreachable: 1,
    })} />)
    expect(screen.getByTestId('count-submitted')).toHaveTextContent('48')
    expect(screen.getByTestId('count-valid')).toHaveTextContent('44')
    expect(screen.getByTestId('count-private')).toHaveTextContent('2')
    expect(screen.getByTestId('count-unreachable')).toHaveTextContent('1')
  })

  it('renders a genuine zero rather than hiding the tile', () => {
    render(<IntakeCounts dashboard={dashboard()} />)
    expect(screen.getByTestId('count-submitted')).toHaveTextContent('0')
    expect(screen.getByTestId('count-rejected')).toHaveTextContent('0')
  })

  it('does not derive totals from any array length', () => {
    // `failing` is a bounded list; the counts come from the backend and must not agree with it
    // by accident.
    const d = dashboard({ total: 50, valid: 20, private: 30 })
    render(<IntakeCounts dashboard={d} />)
    expect(screen.getByTestId('count-private')).toHaveTextContent('30')
    expect(d.failing).toHaveLength(0)
  })
})
