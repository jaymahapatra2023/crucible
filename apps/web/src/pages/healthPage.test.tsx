/**
 * The health page surfaces a tripped safety ceiling (E41-S01 acceptance 7).
 *
 * A ceiling sits far above any human's use, so a trip is a loop somewhere — and a log line
 * nobody is reading at 23:00 is not "surfaced". The page has to say it.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const get = vi.fn()
vi.mock('../lib/apiClient.js', () => ({ get: (path: string) => get(path) }))

const { HealthPage } = await import('./HealthPage.js')

const health = (over: Record<string, unknown> = {}) => ({
  status: 'HEALTHY', database: { reachable: true, migrations: 85 }, providers: [],
  ceilings: { enabled: true, trips: [] }, ...over,
})

describe('safety ceilings on the health page', () => {
  it('says no ceiling has tripped, so silence is a fact and not an omission', async () => {
    get.mockResolvedValue(health())
    render(<HealthPage />)
    expect(await screen.findByText(/No ceiling has refused a request/)).toBeInTheDocument()
  })

  it('names the route, the count and the time when one has, and says what it means', async () => {
    get.mockResolvedValue(health({ ceilings: { enabled: true, trips: [
      { route: 'POST /api/v1/submissions', count: 340, lastAt: '2026-10-03T22:15:00Z' },
    ] } }))
    render(<HealthPage />)
    const item = await screen.findByRole('listitem')
    expect(item).toHaveTextContent('POST /api/v1/submissions')
    expect(item).toHaveTextContent('340')
    expect(item).toHaveTextContent(/retrying in a loop/)
  })

  it('says when the ceilings are switched off, because then nothing is being counted', async () => {
    get.mockResolvedValue(health({ ceilings: { enabled: false, trips: [] } }))
    render(<HealthPage />)
    expect(await screen.findByText(/Switched off/)).toBeInTheDocument()
  })
})
