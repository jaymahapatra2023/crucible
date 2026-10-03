/**
 * Turning each extractor's output into finding rows (E12).
 *
 * One table holds all six kinds, so each mapper reduces its own shape to the shared columns —
 * label, summary, location, confidence — and puts what is kind-specific into `detail`. The UI
 * renders `detail` per kind; nothing else needs to know the difference.
 */
import type { FindingRow } from '../db/discoveryDb.js'
import type { ConcernKey } from './discoveryConcerns.js'
import type {
  CapabilitiesOutput, ClaimsOutput, EndpointsOutput, EntitiesOutput,
  IntegrationsOutput, SecurityOutput, StackOutput,
} from './discoverySchemas.js'

export type MappedFinding = Omit<FindingRow, 'discovery_id' | 'submission_id'>

interface Located {
  path: string
  line_start: number | null
  line_end: number | null
  excerpt: string
  confidence: string
}

function at(source: Located): Pick<MappedFinding, 'path' | 'line_start' | 'line_end' | 'excerpt' | 'confidence'> {
  return {
    path: source.path,
    line_start: source.line_start,
    line_end: source.line_end,
    excerpt: source.excerpt,
    confidence: source.confidence,
  }
}

export function mapEndpoints(out: EndpointsOutput): MappedFinding[] {
  return out.endpoints.map((e) => ({
    kind: 'ENDPOINT',
    label: `${e.method || 'ANY'} ${e.route}`.trim(),
    summary: e.response || e.handler,
    detail: {
      method: e.method, route: e.route, handler: e.handler,
      auth: e.auth, auth_mechanism: e.auth_mechanism,
      parameters: e.parameters, response: e.response,
    },
    ...at(e),
  }))
}

export function mapEntities(out: EntitiesOutput): MappedFinding[] {
  return out.entities.map((e) => ({
    kind: 'ENTITY',
    label: e.name,
    summary: e.summary || e.store,
    detail: {
      store: e.store, fields: e.fields, relationships: e.relationships,
      field_count: e.fields.length,
    },
    ...at(e),
  }))
}

export function mapCapabilities(out: CapabilitiesOutput): MappedFinding[] {
  return out.capabilities.map((c) => ({
    kind: 'CAPABILITY',
    label: c.name,
    summary: c.description,
    detail: { area: c.area, completeness: c.completeness, key_files: c.key_files },
    ...at(c),
  }))
}

export function mapIntegrations(out: IntegrationsOutput): MappedFinding[] {
  return out.integrations.map((i) => ({
    kind: 'INTEGRATION',
    label: i.target,
    summary: i.purpose,
    detail: {
      protocol: i.protocol, direction: i.direction,
      endpoint_hint: i.endpoint_hint, purpose: i.purpose,
    },
    ...at(i),
  }))
}

export function mapSecurity(out: SecurityOutput): MappedFinding[] {
  return out.observations.map((o) => ({
    kind: 'SECURITY',
    label: o.category,
    summary: o.observation,
    // `concern`, not `severity`: it says how much this would matter if it is what it looks
    // like, which is as far as a reader of a budgeted file selection can honestly go.
    detail: {
      category: o.category, concern: o.concern,
      observation: o.observation, benign_explanation: o.benign_explanation,
    },
    ...at(o),
  }))
}

export function mapStack(out: StackOutput): MappedFinding[] {
  return out.stack.map((s) => ({
    kind: 'STACK',
    label: s.version ? `${s.name} ${s.version}` : s.name,
    summary: s.role,
    detail: {
      name: s.name, version: s.version, category: s.category, role: s.role,
      runtime: out.runtime,
    },
    ...at(s),
  }))
}

export function mapConflicts(out: ClaimsOutput) {
  return out.conflicts.map((c) => ({
    claim: c.claim,
    claim_path: c.claim_path,
    claim_line: c.claim_line,
    expected: c.expected,
    // The innocent explanation travels with the conflict rather than being offered separately,
    // so there is no path through the UI that shows the accusation without the caveat.
    observed: c.what_would_explain_it
      ? `${c.observed} — this could still be explained by: ${c.what_would_explain_it}`
      : c.observed,
    confidence: c.confidence,
  }))
}

const MAPPERS: Record<ConcernKey, (out: never) => MappedFinding[]> = {
  endpoints: mapEndpoints as (out: never) => MappedFinding[],
  entities: mapEntities as (out: never) => MappedFinding[],
  capabilities: mapCapabilities as (out: never) => MappedFinding[],
  integrations: mapIntegrations as (out: never) => MappedFinding[],
  security: mapSecurity as (out: never) => MappedFinding[],
  stack: mapStack as (out: never) => MappedFinding[],
  claims: () => [],
}

export function mapFindings(key: ConcernKey, output: unknown): MappedFinding[] {
  return MAPPERS[key](output as never)
}
