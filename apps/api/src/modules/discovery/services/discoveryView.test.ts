/**
 * The honesty rules of the discovery tile strip (E12, P5.1, E08-S06).
 *
 * The defect these exist to prevent: a tile showing "0" for a concern nobody managed to read.
 * On a dashboard, zero and unknown look identical and mean opposite things — one says the team
 * built something self-contained, the other says we failed to look — and a reviewer who cannot
 * tell them apart will read the second as the first and mark a team down for it.
 */
import { describe, expect, it } from 'vitest'
import { buildTiles } from './discoveryView.js'
import type { ConcernResult } from './discoveryConcerns.js'

const result = (over: Partial<ConcernResult>): ConcernResult => ({
  outcome: 'FOUND', count: 0, note: '', costUsd: 0, model: 'm', ...over,
})

const tile = (concerns: Record<string, ConcernResult>, counts: Record<string, number> = {}, conflicts = 0) =>
  (key: string) => buildTiles(concerns, counts, conflicts).find((t) => t.key === key)!

describe('a gap is never a zero', () => {
  it('shows no count for a concern that failed', () => {
    const t = tile({ endpoints: result({ outcome: 'FAILED', note: 'timed out' }) })('endpoints')
    expect(t.count).toBeNull()
    expect(t.outcome).toBe('FAILED')
  })

  it('shows no count for a concern with insufficient evidence', () => {
    const t = tile({ stack: result({ outcome: 'INSUFFICIENT_EVIDENCE' }) })('stack')
    expect(t.count).toBeNull()
  })

  it('shows zero only where zero is a real statement about the submission', () => {
    const t = tile({ integrations: result({ outcome: 'NONE_FOUND' }) })('integrations')
    expect(t.count).toBe(0)
  })

  it('treats a concern missing from the run entirely as failed, not as empty', () => {
    // A run that recorded nothing for a concern is a run that did not complete it.
    expect(tile({})('capabilities').count).toBeNull()
    expect(tile({})('capabilities').outcome).toBe('FAILED')
  })
})

describe('the count matches the list beneath it', () => {
  it('counts the rows that exist, not what the extractor claimed it returned', () => {
    // The per-kind cap means the two can legitimately differ; the number on screen must agree
    // with the list the reviewer can scroll.
    const t = tile(
      { endpoints: result({ outcome: 'FOUND', count: 400 }) }, { ENDPOINT: 80 })('endpoints')
    expect(t.count).toBe(80)
  })

  it('counts conflicts for the claims tile, which has no finding rows', () => {
    const t = tile({ claims: result({ outcome: 'FOUND' }) }, {}, 3)('claims')
    expect(t.count).toBe(3)
  })
})

describe('what draws the eye', () => {
  it('warns on a failed concern, because the page is incomplete', () => {
    expect(tile({ security: result({ outcome: 'FAILED' }) })('security').warn).toBe(true)
  })

  it('warns on an unreadable concern for the same reason', () => {
    expect(tile({ entities: result({ outcome: 'INSUFFICIENT_EVIDENCE' }) })('entities').warn)
      .toBe(true)
  })

  it('warns when there is a security observation to look at', () => {
    const t = tile({ security: result({ outcome: 'FOUND' }) }, { SECURITY: 2 })('security')
    expect(t.warn).toBe(true)
  })

  it('warns when documentation and code appear to disagree', () => {
    expect(tile({ claims: result({ outcome: 'FOUND' }) }, {}, 1)('claims').warn).toBe(true)
  })

  it('does NOT warn on a small submission', () => {
    // Two endpoints is not a fault. Colouring the tile would turn a description into a
    // judgement the evidence does not support.
    const t = tile({ endpoints: result({ outcome: 'FOUND' }) }, { ENDPOINT: 2 })('endpoints')
    expect(t.warn).toBe(false)
  })

  it('does NOT warn when a clean security pass found nothing', () => {
    const t = tile({ security: result({ outcome: 'NONE_FOUND' }) }, { SECURITY: 0 })('security')
    expect(t.warn).toBe(false)
  })

  it('does NOT warn on a large integration count — more is not worse', () => {
    const t = tile(
      { integrations: result({ outcome: 'FOUND' }) }, { INTEGRATION: 30 })('integrations')
    expect(t.warn).toBe(false)
  })
})

describe('every concern gets a tile', () => {
  it('names all seven even when the run recorded none of them', () => {
    const tiles = buildTiles({}, {}, 0)
    expect(tiles.map((t) => t.key)).toEqual([
      'endpoints', 'entities', 'capabilities', 'integrations', 'security', 'stack', 'claims',
    ])
  })

  it('gives every tile a human label rather than a key', () => {
    for (const t of buildTiles({}, {}, 0)) expect(t.label).not.toBe(t.key)
  })

  it('carries the extractor note, so a gap can explain itself', () => {
    const t = tile({ stack: result({ outcome: 'FAILED', note: 'The call timed out twice.' }) })('stack')
    expect(t.note).toBe('The call timed out twice.')
  })
})
