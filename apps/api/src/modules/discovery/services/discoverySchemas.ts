/**
 * Schemas for what each discovery extractor returns (E12, P4.1).
 *
 * Every finding carries `path` and a line range. The reference implementation records only the
 * file, which is enough to display but not enough to CHECK — a reviewer disputing a finding
 * would have to read the whole file to see whether it is there. P0 constraint 2 asks for file
 * and line throughout, and discovery is not exempt.
 *
 * Every list is capped. A model that decides a repository exposes four hundred endpoints has
 * lost track of the question, and a list nobody reads is a cost with no reader.
 */
import { z } from 'zod'

const CONFIDENCE = z.enum(['HIGH', 'MEDIUM', 'LOW'])

/** Where a finding was seen. Shared by every kind, because every kind must be checkable. */
const located = {
  path: z.string().trim().min(1).max(1024),
  line_start: z.coerce.number().int().min(1).nullable().default(null),
  line_end: z.coerce.number().int().min(1).nullable().default(null),
  excerpt: z.string().max(2000).default(''),
  confidence: CONFIDENCE.default('MEDIUM'),
}

const LIST_CAP = 80

/** A concern the extractor could not answer from what it was shown. */
const insufficient = {
  insufficient_evidence: z.boolean().default(false),
  note: z.string().max(2000).default(''),
}

export const endpointsSchema = z.object({
  ...insufficient,
  endpoints: z.array(z.object({
    ...located,
    method: z.string().trim().max(20),
    route: z.string().trim().min(1).max(500),
    handler: z.string().trim().max(300).default(''),
    auth: z.enum(['NONE', 'REQUIRED', 'UNKNOWN']).default('UNKNOWN'),
    auth_mechanism: z.string().trim().max(120).default(''),
    parameters: z.array(z.string().trim().max(120)).max(30).default([]),
    response: z.string().trim().max(200).default(''),
  })).max(LIST_CAP).default([]),
})

export const entitiesSchema = z.object({
  ...insufficient,
  entities: z.array(z.object({
    ...located,
    name: z.string().trim().min(1).max(200),
    store: z.string().trim().max(200).default(''),
    summary: z.string().trim().max(1000).default(''),
    fields: z.array(z.object({
      name: z.string().trim().max(120),
      type: z.string().trim().max(120).default(''),
      key: z.enum(['PRIMARY', 'FOREIGN', 'NONE']).default('NONE'),
      references: z.string().trim().max(200).default(''),
    })).max(60).default([]),
    relationships: z.array(z.string().trim().max(200)).max(30).default([]),
  })).max(LIST_CAP).default([]),
})

export const capabilitiesSchema = z.object({
  ...insufficient,
  capabilities: z.array(z.object({
    ...located,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).default(''),
    // Domain-neutral. The reference uses an insurance vocabulary; hackathon submissions span
    // any domain, and forcing them into one would mislabel most of them.
    area: z.enum([
      'INGESTION', 'PROCESSING', 'STORAGE', 'PRESENTATION', 'INTEGRATION',
      'WORKFLOW', 'REPORTING', 'AUTH', 'OPERATIONS', 'OTHER',
    ]).default('OTHER'),
    completeness: z.enum(['FULL', 'PARTIAL', 'MINIMAL']).default('PARTIAL'),
    key_files: z.array(z.string().trim().max(500)).max(20).default([]),
  })).max(LIST_CAP).default([]),
})

export const integrationsSchema = z.object({
  ...insufficient,
  integrations: z.array(z.object({
    ...located,
    target: z.string().trim().min(1).max(200),
    protocol: z.enum([
      'HTTP', 'GRPC', 'GRAPHQL', 'DATABASE', 'QUEUE', 'FILE', 'WEBSOCKET', 'SDK', 'OTHER',
    ]).default('OTHER'),
    direction: z.enum(['INBOUND', 'OUTBOUND', 'BIDIRECTIONAL', 'UNKNOWN']).default('UNKNOWN'),
    endpoint_hint: z.string().trim().max(500).default(''),
    purpose: z.string().trim().max(500).default(''),
  })).max(LIST_CAP).default([]),
})

/**
 * Security OBSERVATIONS, not vulnerabilities.
 *
 * Crucible is not a vulnerability scanner and must not present itself as one: it has no CVE
 * database, does not resolve dependency versions, and sees only the files a budget let it read.
 * What it can honestly report is patterns a reviewer should look at — a literal that looks like
 * a credential, a query built by string concatenation, an endpoint declaring no auth.
 */
export const securitySchema = z.object({
  ...insufficient,
  observations: z.array(z.object({
    ...located,
    category: z.enum([
      'CREDENTIAL_LITERAL', 'INJECTION_RISK', 'MISSING_AUTH', 'WEAK_CRYPTO',
      'SENSITIVE_LOGGING', 'PERMISSIVE_CORS', 'DEPENDENCY_CONCERN', 'OTHER',
    ]),
    // How much it matters IF it is what it looks like. Deliberately not called "severity":
    // severity implies a verdict this system is not equipped to reach.
    concern: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    observation: z.string().trim().min(10).max(1000),
    // What would make it benign, so a reviewer knows what to check rather than assuming.
    benign_explanation: z.string().trim().max(1000).default(''),
  })).max(LIST_CAP).default([]),
})

export const stackSchema = z.object({
  ...insufficient,
  stack: z.array(z.object({
    ...located,
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().max(60).default(''),
    category: z.enum([
      'LANGUAGE', 'FRAMEWORK', 'DATASTORE', 'MESSAGING', 'INFRASTRUCTURE',
      'TESTING', 'BUILD', 'LIBRARY', 'OTHER',
    ]).default('OTHER'),
    role: z.string().trim().max(300).default(''),
  })).max(LIST_CAP).default([]),
  runtime: z.object({
    containerised: z.boolean().default(false),
    entrypoint: z.string().trim().max(300).default(''),
    notes: z.string().trim().max(1000).default(''),
  }).default({ containerised: false, entrypoint: '', notes: '' }),
})

/**
 * Where documentation claims something the code does not appear to do.
 *
 * Advisory, and the schema says so by demanding `what_would_explain_it`: a claim may be true of
 * code the scan never read, and a conflict reported without that caveat reads as an accusation.
 */
export const claimsSchema = z.object({
  ...insufficient,
  conflicts: z.array(z.object({
    claim: z.string().trim().min(5).max(1000),
    claim_path: z.string().trim().min(1).max(1024),
    claim_line: z.coerce.number().int().min(1).nullable().default(null),
    expected: z.string().trim().min(5).max(1000),
    observed: z.string().trim().min(5).max(1000),
    what_would_explain_it: z.string().trim().max(1000).default(''),
    confidence: CONFIDENCE.default('MEDIUM'),
  })).max(40).default([]),
})

export type EndpointsOutput = z.infer<typeof endpointsSchema>
export type EntitiesOutput = z.infer<typeof entitiesSchema>
export type CapabilitiesOutput = z.infer<typeof capabilitiesSchema>
export type IntegrationsOutput = z.infer<typeof integrationsSchema>
export type SecurityOutput = z.infer<typeof securitySchema>
export type StackOutput = z.infer<typeof stackSchema>
export type ClaimsOutput = z.infer<typeof claimsSchema>
