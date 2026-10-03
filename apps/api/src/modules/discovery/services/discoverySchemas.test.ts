import { describe, expect, it } from 'vitest'
import {
  capabilitiesSchema, claimsSchema, endpointsSchema, entitiesSchema,
  integrationsSchema, securitySchema, stackSchema,
} from './discoverySchemas.js'

const located = { path: 'src/a.ts', line_start: 1, line_end: 2, excerpt: '', confidence: 'HIGH' }

describe('every finding is checkable (P0 constraint 2)', () => {
  it.each([
    ['endpoints', endpointsSchema, { endpoints: [{ method: 'GET', route: '/x' }] }],
    ['entities', entitiesSchema, { entities: [{ name: 'Team' }] }],
    ['capabilities', capabilitiesSchema, { capabilities: [{ name: 'Upload' }] }],
    ['integrations', integrationsSchema, { integrations: [{ target: 'Stripe' }] }],
    ['stack', stackSchema, { stack: [{ name: 'Go' }] }],
  ] as const)('%s rejects a finding with no path', (_name, schema, payload) => {
    // A finding nobody can locate cannot be disputed, and an undisputable finding is worse
    // than a missing one.
    expect(schema.safeParse(payload).success).toBe(false)
  })

  it('accepts a null line range — some findings are file-level and honestly so', () => {
    const parsed = endpointsSchema.parse({
      endpoints: [{ path: 'src/a.ts', method: 'GET', route: '/x' }],
    })
    expect(parsed.endpoints[0]!.line_start).toBeNull()
  })

  it('rejects a line number below 1, which no editor would resolve', () => {
    expect(endpointsSchema.safeParse({
      endpoints: [{ ...located, line_start: 0, method: 'GET', route: '/x' }],
    }).success).toBe(false)
  })
})

describe('caps', () => {
  it('rejects a list beyond the cap rather than truncating it silently', () => {
    const many = Array.from({ length: 81 }, (_, i) => ({ ...located, name: `E${i}` }))
    expect(entitiesSchema.safeParse({ entities: many }).success).toBe(false)
  })

  it('accepts a list at the cap', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...located, name: `E${i}` }))
    expect(entitiesSchema.safeParse({ entities: many }).success).toBe(true)
  })
})

describe('insufficient evidence is available on every concern', () => {
  it.each([
    ['endpoints', endpointsSchema], ['entities', entitiesSchema],
    ['capabilities', capabilitiesSchema], ['integrations', integrationsSchema],
    ['security', securitySchema], ['stack', stackSchema], ['claims', claimsSchema],
  ] as const)('%s parses an explicit gap with an empty list', (_name, schema) => {
    const parsed = schema.parse({ insufficient_evidence: true, note: 'no manifest was read' })
    expect((parsed as { insufficient_evidence: boolean }).insufficient_evidence).toBe(true)
  })

  it('defaults to false, so a silent omission is not read as a gap', () => {
    expect(stackSchema.parse({}).insufficient_evidence).toBe(false)
  })
})

describe('security observations', () => {
  it('requires a real observation, not a one-word label', () => {
    expect(securitySchema.safeParse({
      observations: [{ ...located, category: 'OTHER', concern: 'LOW', observation: 'bad' }],
    }).success).toBe(false)
  })

  it('rejects a category outside the declared vocabulary', () => {
    expect(securitySchema.safeParse({
      observations: [{
        ...located, category: 'RCE', concern: 'HIGH', observation: 'remote code execution',
      }],
    }).success).toBe(false)
  })

  it('has no severity field at all — the vocabulary is the guard', () => {
    const parsed = securitySchema.parse({
      observations: [{
        ...located, category: 'WEAK_CRYPTO', concern: 'MEDIUM',
        observation: 'MD5 is used to hash a password.', severity: 'CRITICAL',
      }],
    })
    expect(parsed.observations[0]).not.toHaveProperty('severity')
  })
})

describe('claim conflicts', () => {
  it('requires a location for the claim, so a reviewer can read it in context', () => {
    expect(claimsSchema.safeParse({
      conflicts: [{ claim: 'Supports SSO', expected: 'a SAML handler', observed: 'none found' }],
    }).success).toBe(false)
  })

  it('caps conflicts lower than findings — a long list of doubts is not read', () => {
    const many = Array.from({ length: 41 }, () => ({
      claim: 'claims a thing', claim_path: 'README.md',
      expected: 'the thing', observed: 'not the thing',
    }))
    expect(claimsSchema.safeParse({ conflicts: many }).success).toBe(false)
  })
})

describe('capability areas are domain-neutral', () => {
  it('has no vocabulary borrowed from one industry', () => {
    const parsed = capabilitiesSchema.parse({
      capabilities: [{ ...located, name: 'Rostering', area: 'WORKFLOW' }],
    })
    expect(parsed.capabilities[0]!.area).toBe('WORKFLOW')
  })

  it('falls back to OTHER rather than forcing a poor fit', () => {
    const parsed = capabilitiesSchema.parse({ capabilities: [{ ...located, name: 'Odd thing' }] })
    expect(parsed.capabilities[0]!.area).toBe('OTHER')
  })
})

describe('stack runtime', () => {
  it('defaults to not containerised rather than to unknown-shaped undefined', () => {
    expect(stackSchema.parse({}).runtime).toEqual({
      containerised: false, entrypoint: '', notes: '',
    })
  })
})
