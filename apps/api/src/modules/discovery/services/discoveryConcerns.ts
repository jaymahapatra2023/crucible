/**
 * The seven things discovery asks about, and how each one finds its evidence (E12).
 *
 * One concern per model call. The reference implementation asks a single prompt to return eleven
 * shapes at once, which means a malformed fragment anywhere loses the whole scan and a repository
 * whose endpoints extracted perfectly still shows nothing. Here a failed concern costs that
 * concern, is recorded as FAILED rather than as an empty list, and the other six stand.
 *
 * Each concern carries an `evidenceSpec` written in the same form a criterion uses, so file
 * selection runs through the one context builder (P1.5 clause 6) rather than a second ranking
 * implementation that would drift from it.
 */
import type { EvidenceTarget } from '@crucible/scoring'
import type { ZodTypeAny } from 'zod'
import {
  capabilitiesSchema, claimsSchema, endpointsSchema, entitiesSchema,
  integrationsSchema, securitySchema, stackSchema,
} from './discoverySchemas.js'

export type ConcernKey =
  | 'endpoints' | 'entities' | 'capabilities' | 'integrations'
  | 'security' | 'stack' | 'claims'

export type FindingKind =
  | 'ENDPOINT' | 'ENTITY' | 'CAPABILITY' | 'INTEGRATION' | 'SECURITY' | 'STACK'

export interface Concern {
  key: ConcernKey
  callKey: string
  /** The finding kind rows land under. Null for `claims`, which produces conflicts instead. */
  kind: FindingKind | null
  target: EvidenceTarget
  schema: ZodTypeAny
  /**
   * Whether an empty result is a legitimate answer.
   *
   * It is for integrations and security — an application really can talk to nothing and really
   * can have nothing worth flagging. It is not for endpoints, entities or stack: a repository
   * with no data model at all is so rare that an empty list almost always means the extractor
   * was shown the wrong files, and showing "0 entities" would be a false statement about the
   * team's work (P5.1).
   */
  emptyIsMeaningful: boolean
}

/** Concerns run in this order; `claims` last, because it reads what the others found. */
export const CONCERNS: readonly Concern[] = [
  {
    key: 'endpoints',
    callKey: 'discovery.endpoints',
    kind: 'ENDPOINT',
    schema: endpointsSchema,
    emptyIsMeaningful: false,
    target: {
      criterionId: 'discovery.endpoints',
      name: 'API surface',
      description: 'The externally reachable entry points this application exposes.',
      evidenceSpec:
        'Route registrations, controllers, handlers and resolvers: app.get, router.post, ' +
        '@Controller, @RequestMapping, urlpatterns, FastAPI decorators, GraphQL resolvers and ' +
        'typeDefs, gRPC service definitions, WebSocket subscriptions, queue consumers, ' +
        'serverless function handlers, and the middleware that authenticates them.',
    },
  },
  {
    key: 'entities',
    callKey: 'discovery.entities',
    kind: 'ENTITY',
    schema: entitiesSchema,
    emptyIsMeaningful: false,
    target: {
      criterionId: 'discovery.entities',
      name: 'Data model',
      description: 'What this application stores, and how those things relate.',
      evidenceSpec:
        'CREATE TABLE and ALTER TABLE statements, migrations, schema definitions, ORM models ' +
        'and entity classes, columns, primary keys, foreign keys and references, indexes, ' +
        'Prisma and Drizzle schemas, Mongoose and SQLAlchemy models, Django models, ' +
        'persisted type declarations and the queries that read them.',
    },
  },
  {
    key: 'capabilities',
    callKey: 'discovery.capabilities',
    kind: 'CAPABILITY',
    schema: capabilitiesSchema,
    emptyIsMeaningful: false,
    target: {
      criterionId: 'discovery.capabilities',
      name: 'Capabilities',
      description: 'What a user or another system can accomplish with this application.',
      evidenceSpec:
        'Service classes, use-case and command handlers, workflow and pipeline definitions, ' +
        'business rules and validation, scheduled jobs, background workers, report and export ' +
        'generation, search and matching logic, notification dispatch, and the user interface ' +
        'screens and actions that invoke them.',
    },
  },
  {
    key: 'integrations',
    callKey: 'discovery.integrations',
    kind: 'INTEGRATION',
    schema: integrationsSchema,
    emptyIsMeaningful: true,
    target: {
      criterionId: 'discovery.integrations',
      name: 'External systems',
      description: 'The systems outside this process that it talks to.',
      evidenceSpec:
        'HTTP clients and base URLs, fetch and axios and requests calls, SDK client ' +
        'construction, database connection strings and pools, message brokers and topics, ' +
        'object storage buckets, identity providers and OAuth configuration, model and payment ' +
        'provider keys, webhook receivers, and the environment variables that configure them.',
    },
  },
  {
    key: 'security',
    callKey: 'discovery.security',
    kind: 'SECURITY',
    schema: securitySchema,
    emptyIsMeaningful: true,
    target: {
      criterionId: 'discovery.security',
      name: 'Security observations',
      description: 'Patterns in the code a security reviewer would want to look at.',
      evidenceSpec:
        'Authentication and authorisation checks and the routes that lack them, hard-coded ' +
        'keys tokens passwords and secrets, SQL and command strings built by concatenation or ' +
        'interpolation, eval and deserialisation of untrusted input, hashing and encryption ' +
        'choices, CORS and CSP configuration, cookie and session flags, logging of credentials ' +
        'or personal data, and input validation at the boundary.',
    },
  },
  {
    key: 'stack',
    callKey: 'discovery.stack',
    kind: 'STACK',
    schema: stackSchema,
    emptyIsMeaningful: false,
    target: {
      criterionId: 'discovery.stack',
      name: 'Technology stack',
      description: 'The languages, frameworks, datastores and tooling this is built on.',
      evidenceSpec:
        'package.json, requirements.txt, pyproject.toml, go.mod, pom.xml, build.gradle, ' +
        'Gemfile, Cargo.toml, composer.json, Dockerfile, docker-compose, Makefile, ' +
        'tsconfig, workflow and pipeline files, dependencies and devDependencies, engines, ' +
        'runtime versions, entrypoint and start scripts, and the imports that use them.',
    },
  },
  {
    key: 'claims',
    callKey: 'discovery.claims',
    kind: null,
    schema: claimsSchema,
    emptyIsMeaningful: true,
    target: {
      criterionId: 'discovery.claims',
      name: 'Documentation claims',
      description: 'What the repository says about itself.',
      evidenceSpec:
        'README, documentation, architecture notes, feature lists, setup and usage ' +
        'instructions, changelog, demo script, pitch and submission notes, and any file ' +
        'describing what the application does or supports.',
    },
  },
]

export function concernFor(key: ConcernKey): Concern {
  const found = CONCERNS.find((c) => c.key === key)
  if (!found) throw new Error(`Unknown discovery concern: ${key}`)
  return found
}

/** Per-concern outcome, recorded on the run so a gap is never read as an absence (P5.1). */
export type ConcernOutcome = 'FOUND' | 'NONE_FOUND' | 'INSUFFICIENT_EVIDENCE' | 'FAILED'

export interface ConcernResult {
  outcome: ConcernOutcome
  count: number
  note: string
  costUsd: number
  model: string | null
}
