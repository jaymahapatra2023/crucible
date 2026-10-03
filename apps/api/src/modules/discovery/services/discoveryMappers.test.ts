import { describe, expect, it } from 'vitest'
import {
  mapCapabilities, mapConflicts, mapEndpoints, mapEntities,
  mapFindings, mapIntegrations, mapSecurity, mapStack,
} from './discoveryMappers.js'
import {
  capabilitiesSchema, claimsSchema, endpointsSchema, entitiesSchema,
  integrationsSchema, securitySchema, stackSchema,
} from './discoverySchemas.js'

const located = { path: 'src/a.ts', line_start: 4, line_end: 9, excerpt: 'x', confidence: 'HIGH' }

describe('endpoint mapping', () => {
  it('labels a finding with the method and route a reviewer would search for', () => {
    const out = endpointsSchema.parse({
      endpoints: [{ ...located, method: 'POST', route: '/api/things' }],
    })
    expect(mapEndpoints(out)[0]!.label).toBe('POST /api/things')
  })

  it('keeps the auth verdict in detail rather than folding it into the label', () => {
    const out = endpointsSchema.parse({
      endpoints: [{ ...located, method: 'GET', route: '/x', auth: 'NONE' }],
    })
    // Folding "unauthenticated" into the label would make a security claim in a list that is
    // only describing the API surface.
    expect(mapEndpoints(out)[0]!.label).not.toMatch(/auth|none/i)
    expect(mapEndpoints(out)[0]!.detail['auth']).toBe('NONE')
  })

  it('defaults a missing method to ANY rather than producing a label starting with a space', () => {
    const out = endpointsSchema.parse({ endpoints: [{ ...located, method: '', route: '/x' }] })
    expect(mapEndpoints(out)[0]!.label).toBe('ANY /x')
  })

  it('carries the location through, because a finding must be checkable', () => {
    const out = endpointsSchema.parse({ endpoints: [{ ...located, method: 'GET', route: '/x' }] })
    expect(mapEndpoints(out)[0]).toMatchObject({ path: 'src/a.ts', line_start: 4, line_end: 9 })
  })
})

describe('entity mapping', () => {
  it('records the field count so a list can show shape without loading every field', () => {
    const out = entitiesSchema.parse({
      entities: [{
        ...located, name: 'Team',
        fields: [{ name: 'id' }, { name: 'name' }],
      }],
    })
    expect(mapEntities(out)[0]!.detail['field_count']).toBe(2)
  })

  it('falls back to the store when no summary was given', () => {
    const out = entitiesSchema.parse({
      entities: [{ ...located, name: 'Team', store: 'postgres table team' }],
    })
    expect(mapEntities(out)[0]!.summary).toBe('postgres table team')
  })
})

describe('capability mapping', () => {
  it('keeps completeness as a stated fact, not as a score', () => {
    const out = capabilitiesSchema.parse({
      capabilities: [{ ...located, name: 'Upload', completeness: 'MINIMAL' }],
    })
    const mapped = mapCapabilities(out)[0]!
    expect(mapped.detail['completeness']).toBe('MINIMAL')
    // Nothing numeric: a capability finding must not be mistaken for a criterion score.
    expect(Object.values(mapped.detail).every((v) => typeof v !== 'number')).toBe(true)
  })
})

describe('integration mapping', () => {
  it('labels by the external system, which is what a reviewer scans the list for', () => {
    const out = integrationsSchema.parse({
      integrations: [{ ...located, target: 'Stripe API', protocol: 'HTTP' }],
    })
    expect(mapIntegrations(out)[0]!.label).toBe('Stripe API')
  })
})

describe('security mapping', () => {
  it('records "concern", never "severity"', () => {
    const out = securitySchema.parse({
      observations: [{
        ...located, category: 'INJECTION_RISK', concern: 'HIGH',
        observation: 'A query is built by concatenation.',
      }],
    })
    const detail = mapSecurity(out)[0]!.detail
    expect(detail['concern']).toBe('HIGH')
    // Severity is a property of a confirmed vulnerability. This system confirms nothing.
    expect(detail).not.toHaveProperty('severity')
  })

  it('carries the benign explanation alongside every observation', () => {
    const out = securitySchema.parse({
      observations: [{
        ...located, category: 'CREDENTIAL_LITERAL', concern: 'MEDIUM',
        observation: 'A literal that looks like a key.',
        benign_explanation: 'It may be a test fixture.',
      }],
    })
    expect(mapSecurity(out)[0]!.detail['benign_explanation']).toBe('It may be a test fixture.')
  })
})

describe('stack mapping', () => {
  it('shows the version in the label where one was declared', () => {
    const out = stackSchema.parse({ stack: [{ ...located, name: 'Fastify', version: '^5.2.0' }] })
    expect(mapStack(out)[0]!.label).toBe('Fastify ^5.2.0')
  })

  it('omits the version rather than printing an empty suffix', () => {
    const out = stackSchema.parse({ stack: [{ ...located, name: 'Fastify' }] })
    expect(mapStack(out)[0]!.label).toBe('Fastify')
  })
})

describe('conflict mapping', () => {
  it('attaches the innocent explanation to the observation itself', () => {
    // There must be no path through the UI that shows the conflict without the caveat, so the
    // caveat travels in the same string rather than in a field a renderer could drop.
    const out = claimsSchema.parse({
      conflicts: [{
        claim: 'Supports SAML single sign-on',
        claim_path: 'README.md',
        expected: 'a SAML library and an assertion handler',
        observed: 'only a local password login was found',
        what_would_explain_it: 'the SSO code may sit outside what was scanned',
      }],
    })
    expect(mapConflicts(out)[0]!.observed).toContain('could still be explained by')
    expect(mapConflicts(out)[0]!.observed).toContain('outside what was scanned')
  })

  it('does not append a dangling caveat when none was given', () => {
    const out = claimsSchema.parse({
      conflicts: [{
        claim: 'Has a REST API', claim_path: 'README.md',
        expected: 'route registrations', observed: 'no routes were found',
      }],
    })
    expect(mapConflicts(out)[0]!.observed).toBe('no routes were found')
  })
})

describe('mapFindings dispatch', () => {
  it('routes each concern to its own mapper', () => {
    const out = stackSchema.parse({ stack: [{ ...located, name: 'Go' }] })
    expect(mapFindings('stack', out)[0]!.kind).toBe('STACK')
  })

  it('produces no findings for claims — they are conflicts, not findings', () => {
    expect(mapFindings('claims', claimsSchema.parse({}))).toEqual([])
  })
})
