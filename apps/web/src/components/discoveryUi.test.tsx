/**
 * The discovery UI's honesty rules (E12, P5.1, P5.7).
 *
 * The defect these exist to prevent: a reviewer reading "0" for a concern nobody managed to
 * read. On a dashboard a zero and an unknown look identical and mean opposite things — one says
 * the team built something self-contained, the other says we failed to look — and a reviewer who
 * cannot tell them apart will read the second as the first.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiscoveryTiles } from './DiscoveryTiles.js'
import { DiscoverySection } from './DiscoverySection.js'
import { DiscoveryConflicts } from './DiscoveryConflicts.js'
import { FindingDetail } from './FindingDetail.js'
import type { Conflict, DiscoveryTile, Finding } from '../lib/discoveryApi.js'

const tile = (over: Partial<DiscoveryTile>): DiscoveryTile => ({
  key: 'integrations', label: 'Integrations', count: 3, outcome: 'FOUND',
  warn: false, note: '', ...over,
})

const finding = (over: Partial<Finding>): Finding => ({
  finding_id: 1,
  kind: 'ENDPOINT', label: 'GET /api/teams', summary: 'Lists teams', detail: {},
  path: 'src/routes/teams.ts', line_start: 4, line_end: 6,
  excerpt: "app.get('/api/teams', listTeams)", confidence: 'HIGH', ...over,
})

describe('the tile strip', () => {
  it('shows a count where a count is a true statement', () => {
    render(<DiscoveryTiles tiles={[tile({ count: 3 })]} selected={null} onSelect={vi.fn()} />)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('shows zero where the extractor read the code and found none', () => {
    render(<DiscoveryTiles tiles={[tile({ count: 0, outcome: 'NONE_FOUND' })]} selected={null} onSelect={vi.fn()} />)
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('NEVER shows zero for a concern that could not be read', () => {
    render(<DiscoveryTiles
      tiles={[tile({ count: null, outcome: 'INSUFFICIENT_EVIDENCE', warn: true })]}
      selected={null} onSelect={vi.fn()} />)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByText('Not determined')).toBeInTheDocument()
  })

  it('says in as many words that the state is not a zero', () => {
    render(<DiscoveryTiles
      tiles={[tile({ count: null, outcome: 'FAILED', warn: true })]}
      selected={null} onSelect={vi.fn()} />)
    expect(screen.getByText('not a zero')).toBeInTheDocument()
    expect(screen.getByText('Could not read')).toBeInTheDocument()
  })

  it('carries the extractor note, so a gap can explain itself on hover', () => {
    render(<DiscoveryTiles
      tiles={[tile({ count: null, outcome: 'FAILED', warn: true, note: 'The call timed out.' })]}
      selected={null} onSelect={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveAttribute('title', 'The call timed out.')
  })

  it('says a tile needs a look in WORDS, not only by colour (P5.5)', () => {
    // The amber border speaks to a sighted reader and to nobody else.
    render(<DiscoveryTiles
      tiles={[tile({ count: null, outcome: 'FAILED', warn: true })]}
      selected={null} onSelect={vi.fn()} />)
    expect(screen.getByText(/needs a look/i)).toBeInTheDocument()
  })

  it('does not say a settled tile needs a look', () => {
    render(<DiscoveryTiles tiles={[tile({ warn: false })]} selected={null} onSelect={vi.fn()} />)
    expect(screen.queryByText(/needs a look/i)).not.toBeInTheDocument()
  })

  it('reports selection state to assistive technology, not only by colour (P5.5)', () => {
    render(<DiscoveryTiles tiles={[tile({})]} selected="integrations" onSelect={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  })

  it('selects a concern when its tile is activated', async () => {
    const onSelect = vi.fn()
    render(<DiscoveryTiles tiles={[tile({})]} selected={null} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith('integrations')
  })
})

describe('a findings section', () => {
  it('shows every finding with the file and line it came from', () => {
    render(<DiscoverySection title="API surface" tile={tile({ key: 'endpoints', count: 1 })}
      findings={[finding({})]} open />)
    expect(screen.getByText('src/routes/teams.ts:4–6')).toBeInTheDocument()
  })

  it('shows the excerpt, so a finding can be disputed without leaving the page', () => {
    render(<DiscoverySection title="API surface" tile={tile({ key: 'endpoints', count: 1 })}
      findings={[finding({})]} open />)
    expect(screen.getByText("app.get('/api/teams', listTeams)")).toBeInTheDocument()
  })

  it('states a gap rather than rendering an empty list', () => {
    render(<DiscoverySection title="Data model"
      tile={tile({ key: 'entities', count: null, outcome: 'INSUFFICIENT_EVIDENCE', note: 'No migration was read.' })}
      findings={[]} open />)
    expect(screen.getByText(/could not be determined/i)).toBeInTheDocument()
    expect(screen.getByText('No migration was read.')).toBeInTheDocument()
    expect(screen.getByText(/not a statement that the submission has none/i)).toBeInTheDocument()
  })

  it('says a genuinely empty concern is empty, which is a different sentence', () => {
    render(<DiscoverySection title="External systems"
      tile={tile({ key: 'integrations', count: 0, outcome: 'NONE_FOUND' })} findings={[]} open />)
    expect(screen.getByText(/read the code and found none/i)).toBeInTheDocument()
    expect(screen.queryByText(/could not be determined/i)).not.toBeInTheDocument()
  })

  it('shows confidence on each finding rather than presenting all as equal', () => {
    render(<DiscoverySection title="API surface" tile={tile({ key: 'endpoints', count: 1 })}
      findings={[finding({ confidence: 'LOW' })]} open />)
    expect(screen.getByText('low confidence')).toBeInTheDocument()
  })
})

describe('finding detail', () => {
  it('shows an unauthenticated endpoint as NONE only when that was observed', () => {
    render(<FindingDetail finding={finding({ detail: { auth: 'NONE' } })} />)
    expect(screen.getByText('NONE')).toBeInTheDocument()
  })

  it('shows UNKNOWN as UNKNOWN — never as none, which would invent a security finding', () => {
    render(<FindingDetail finding={finding({ detail: { auth: 'UNKNOWN' } })} />)
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument()
    expect(screen.queryByText('NONE')).not.toBeInTheDocument()
  })

  it('labels a security observation by concern, not by severity', () => {
    render(<FindingDetail finding={finding({
      kind: 'SECURITY', detail: { concern: 'HIGH', benign_explanation: 'It may be a fixture.' },
    })} />)
    expect(screen.getByText(/concern if confirmed/i)).toBeInTheDocument()
    expect(screen.queryByText(/severity/i)).not.toBeInTheDocument()
  })

  it('shows what would make a security observation benign, next to the observation', () => {
    render(<FindingDetail finding={finding({
      kind: 'SECURITY', detail: { concern: 'HIGH', benign_explanation: 'It may be a test fixture.' },
    })} />)
    expect(screen.getByText(/check this first/i)).toBeInTheDocument()
    expect(screen.getByText(/It may be a test fixture\./)).toBeInTheDocument()
  })

  it('renders an entity as a field table a reviewer can read', () => {
    render(<FindingDetail finding={finding({
      kind: 'ENTITY',
      detail: { store: 'postgres', fields: [{ name: 'team_id', type: 'bigint', key: 'PRIMARY' }] },
    })} />)
    const row = screen.getByRole('row', { name: /team_id/ })
    expect(within(row).getByText('PRIMARY')).toBeInTheDocument()
  })
})

const conflict = (over: Partial<Conflict> = {}): Conflict => ({
  conflict_id: 1, claim: 'Supports SAML single sign-on.', claim_path: 'README.md', claim_line: 3,
  expected: 'a SAML library and an assertion handler',
  observed: 'only a local login was found — this could still be explained by: the SSO code may sit outside what was scanned',
  confidence: 'MEDIUM', ...over,
})

describe('documentation against code', () => {
  it('frames a conflict as worth checking, never as a discrepancy found', () => {
    render(<DiscoveryConflicts conflicts={[conflict()]} />)
    expect(screen.getByText('Worth checking')).toBeInTheDocument()
  })

  it('says plainly that these are not findings of dishonesty', () => {
    render(<DiscoveryConflicts conflicts={[conflict()]} />)
    expect(screen.getByText(/not findings of fact and certainly not findings of dishonesty/i))
      .toBeInTheDocument()
  })

  it('shows the innocent explanation alongside the observation', () => {
    render(<DiscoveryConflicts conflicts={[conflict()]} />)
    expect(screen.getByText(/could still be explained by/i)).toBeInTheDocument()
  })

  it('shows the caveat without any interaction — it is never behind a toggle', () => {
    const { container } = render(<DiscoveryConflicts conflicts={[conflict()]} />)
    expect(container.querySelector('details')).toBeNull()
  })

  it('says nothing disagreed rather than rendering an empty list', () => {
    render(<DiscoveryConflicts conflicts={[]} />)
    expect(screen.getByText(/Nothing in the documentation contradicted/i)).toBeInTheDocument()
  })
})
