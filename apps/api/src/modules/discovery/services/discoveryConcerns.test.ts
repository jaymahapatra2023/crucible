import { describe, expect, it } from 'vitest'
import { CONCERNS, concernFor } from './discoveryConcerns.js'
import { summariseFindings } from './discoveryService.js'
import type { MappedFinding } from './discoveryMappers.js'

describe('the concern registry', () => {
  it('registers one call key per concern, all distinct (P3.2)', () => {
    const keys = CONCERNS.map((c) => c.callKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('names every call key under the discovery module', () => {
    for (const c of CONCERNS) expect(c.callKey).toMatch(/^discovery\./)
  })

  it('runs claims last, because it reads what the others found', () => {
    expect(CONCERNS[CONCERNS.length - 1]!.key).toBe('claims')
  })

  it('gives every concern an evidence specification substantial enough to rank files by', () => {
    // A one-line spec ranks nothing: the context builder extracts terms from it, and a spec of
    // three words would select three files at random.
    for (const c of CONCERNS) expect(c.target.evidenceSpec.length).toBeGreaterThan(120)
  })

  it('treats an empty result as meaningful only where an empty result is possible', () => {
    // An application really can integrate with nothing and really can have nothing to flag.
    expect(concernFor('integrations').emptyIsMeaningful).toBe(true)
    expect(concernFor('security').emptyIsMeaningful).toBe(true)
    // A repository with no data model, no endpoints and no stack is almost always a repository
    // whose extractor was shown the wrong files.
    expect(concernFor('entities').emptyIsMeaningful).toBe(false)
    expect(concernFor('endpoints').emptyIsMeaningful).toBe(false)
    expect(concernFor('stack').emptyIsMeaningful).toBe(false)
  })

  it('maps six concerns to a finding kind and claims to none', () => {
    expect(CONCERNS.filter((c) => c.kind !== null)).toHaveLength(6)
    expect(concernFor('claims').kind).toBeNull()
  })

  it('refuses an unknown concern rather than returning undefined', () => {
    expect(() => concernFor('nonsense' as never)).toThrow(/Unknown discovery concern/)
  })

  it('uses a domain-neutral vocabulary throughout — submissions span any domain', () => {
    const text = JSON.stringify(CONCERNS).toLowerCase()
    for (const word of ['insurance', 'policy holder', 'claims handling', 'underwriting']) {
      expect(text).not.toContain(word)
    }
  })
})

const finding = (label: string, path = 'src/a.ts'): MappedFinding => ({
  kind: 'ENDPOINT', label, summary: 'does a thing', detail: {},
  path, line_start: 1, line_end: 2, excerpt: '', confidence: 'HIGH',
})

describe('what the claims extractor is told the code contains', () => {
  it('summarises each concern under its own heading', () => {
    const text = summariseFindings({ endpoints: [finding('GET /x')] })
    expect(text).toContain('ENDPOINTS')
    expect(text).toContain('GET /x')
  })

  it('caps a long list and says how much was left out', () => {
    const many = Array.from({ length: 50 }, (_, i) => finding(`GET /r${i}`))
    const text = summariseFindings({ endpoints: many })
    expect(text).toContain('...and 20 more')
    expect(text).not.toContain('GET /r40')
  })

  it('tells the extractor it has no basis for a conflict when nothing was found', () => {
    // Left blank, the claims pass would compare a README against silence and read every
    // unmentioned feature as a contradiction.
    expect(summariseFindings({})).toMatch(/no basis for a conflict/)
  })

  it('omits a concern that produced an empty array rather than printing an empty heading', () => {
    expect(summariseFindings({ endpoints: [], entities: [finding('Team')] }))
      .not.toContain('ENDPOINTS')
  })

  it('carries the path, so a claimed conflict can be traced to a file', () => {
    expect(summariseFindings({ entities: [finding('Team', 'db/schema.sql')] }))
      .toContain('db/schema.sql')
  })
})
