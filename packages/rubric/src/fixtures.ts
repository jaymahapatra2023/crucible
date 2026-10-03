/**
 * Fixture rubrics for both challenges (E02-S03 acceptance 4).
 *
 * These exist so E06 and E07 can be built and tested *before* any real brief is written — which
 * is the entire reason this story goes first. They are realistic rather than minimal: vague
 * criteria are the failure mode E02-S05 is built to catch, so fixtures that would not survive
 * the quality gate would make downstream tests prove nothing.
 */
import { DEFAULT_DIMENSION_WEIGHTS } from './defaults.js'
import type { Anchors, Criterion, Rubric } from './types.js'

/** The five levels, in order, as a tuple — so a miscount is a type error rather than a silent shift. */
type AnchorTuple = [string, string, string, string, string]

function anchors(...levels: AnchorTuple): Anchors {
  return { 0: levels[0], 1: levels[1], 2: levels[2], 3: levels[3], 4: levels[4] }
}

/** The challenge-agnostic 70% — identical across challenges by design (finding F5). */
function sharedCriteria(prefix: string): Criterion[] {
  return [
    {
      criterionId: `${prefix}_eq_01`,
      dimension: 'ENGINEERING_QUALITY',
      name: 'Separation of concerns',
      description: 'Business logic is separated from transport, persistence and presentation.',
      weight: 0.4,
      evidenceSpec:
        'A reader can point to modules where request handling, domain logic and data access are ' +
        'in different files, and to a call path that crosses them in one direction.',
      anchors: anchors(
        'All logic is in one file or inside request handlers.',
        'Some helpers are extracted, but handlers still contain domain rules.',
        'Layers exist by name but leak — handlers query storage directly.',
        'Clear layers with a one-directional dependency flow on the main path.',
        'Clear layers throughout, with the boundary enforced by types or interfaces.',
      ),
      sortOrder: 0,
    },
    {
      criterionId: `${prefix}_eq_02`,
      dimension: 'ENGINEERING_QUALITY',
      name: 'Error handling on the main path',
      description: 'Failures are handled explicitly rather than swallowed or left to crash.',
      weight: 0.35,
      evidenceSpec:
        'A reader can point to code that catches a failure from an external call and either ' +
        'recovers, reports it, or fails with a specific message — not an empty catch block.',
      anchors: anchors(
        'No error handling; failures propagate as unhandled exceptions.',
        'Catch blocks exist but are empty or log only.',
        'Errors are caught and logged, but the caller cannot distinguish failure from success.',
        'Errors are handled with specific messages on the main path.',
        'Errors are classified, handled, surfaced to the user, and covered by a test.',
      ),
      sortOrder: 1,
    },
    {
      criterionId: `${prefix}_eq_03`,
      dimension: 'ENGINEERING_QUALITY',
      name: 'Automated tests exist and run',
      description: 'The submission carries tests that exercise its own logic.',
      weight: 0.25,
      evidenceSpec:
        'A reader can point to test files, a runner configuration, and at least one assertion ' +
        'about the project’s own behaviour rather than a framework default.',
      anchors: anchors(
        'No test files.',
        'A test directory exists but contains only scaffolding or skipped tests.',
        'A few tests exist but assert trivia, or do not run.',
        'Meaningful tests covering the main path, runnable with one command.',
        'Meaningful tests covering the main path and failure cases, wired into CI.',
      ),
      sortOrder: 2,
    },
    {
      criterionId: `${prefix}_ps_01`,
      dimension: 'PRINCIPLES_STANDARDS',
      name: 'Secrets are not committed',
      description: 'Credentials are supplied by configuration, not embedded in the repository.',
      weight: 0.5,
      evidenceSpec:
        'A reader can confirm that API keys, tokens and passwords are read from environment or ' +
        'a secret store, and can point to configuration handling rather than a literal.',
      anchors: anchors(
        'Live credentials are committed in the repository.',
        'Credentials appear in committed example files that look real.',
        'Credentials come from configuration, but at least one literal remains.',
        'All credentials come from configuration, with an example file carrying placeholders.',
        'All credentials come from configuration, validated at startup, with a documented setup.',
      ),
      sortOrder: 3,
    },
    {
      criterionId: `${prefix}_ps_02`,
      dimension: 'PRINCIPLES_STANDARDS',
      name: 'Input from outside the system is validated',
      description: 'Data arriving from a user, a network call or a file is checked before use.',
      weight: 0.5,
      evidenceSpec:
        'A reader can point to validation applied to an external input before it reaches ' +
        'storage or business logic.',
      anchors: anchors(
        'External input is used directly with no checks.',
        'Only presence is checked; types and ranges are not.',
        'Some endpoints validate, others do not.',
        'All external entry points validate against an explicit schema.',
        'All entry points validate, and rejections return a specific, actionable message.',
      ),
      sortOrder: 4,
    },
    {
      criterionId: `${prefix}_or_01`,
      dimension: 'ORIGINALITY',
      name: 'Beyond the starter template',
      description: 'The submission contains substantive work beyond generated scaffolding.',
      weight: 1,
      evidenceSpec:
        'A reader can point to files whose content is specific to this problem rather than ' +
        'produced by a framework generator.',
      anchors: anchors(
        'Unmodified scaffolding only.',
        'Scaffolding with cosmetic edits.',
        'Some original code, but the bulk is generated.',
        'Substantial original implementation addressing the problem.',
        'Substantial original implementation with a non-obvious approach the authors explain.',
      ),
      sortOrder: 5,
    },
    {
      criterionId: `${prefix}_rn_01`,
      dimension: 'RUNS',
      name: 'Builds and stays running',
      description:
        'Objective result from the sandboxed build probe. No model participates in this score.',
      weight: 1,
      evidenceSpec:
        'The build probe records an exit code, a duration, and whether the process stayed up ' +
        'for the configured settle period.',
      anchors: anchors(
        'Does not build.',
        'Builds only after manual intervention not declared by the team.',
        'Builds but exits immediately or crashes on start.',
        'Builds and starts, staying up for the settle period.',
        'Builds, starts, stays up, and responds to a basic liveness check.',
      ),
      sortOrder: 6,
    },
  ]
}

function fidelityCriteria(prefix: string, specs: Array<{
  name: string; description: string; evidenceSpec: string; sourceRef: string; anchors: Anchors
}>): Criterion[] {
  const weight = Math.round((1 / specs.length) * 1e6) / 1e6
  const weights = specs.map(() => weight)
  const residue = Math.round((1 - weights.reduce((a, b) => a + b, 0)) * 1e6) / 1e6
  if (residue !== 0 && weights[0] !== undefined) weights[0] = Math.round((weights[0] + residue) * 1e6) / 1e6

  return specs.map((s, i) => ({
    criterionId: `${prefix}_cf_${String(i + 1).padStart(2, '0')}`,
    dimension: 'CHALLENGE_FIDELITY' as const,
    name: s.name,
    description: s.description,
    weight: weights[i] ?? weight,
    evidenceSpec: s.evidenceSpec,
    anchors: s.anchors,
    sourceRef: s.sourceRef,
    sortOrder: 100 + i,
  }))
}

function build(challengeId: string, prefix: string, fidelity: Criterion[]): Rubric {
  return {
    rubricId: `rb_${prefix}`,
    challengeId,
    version: 1,
    status: 'FROZEN',
    contentHash: null,
    dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS },
    criteria: [...fidelity, ...sharedCriteria(prefix)],
    generatedAt: '2026-09-22T09:00:00.000Z',
    approvedBy: 'fixture@crucible.local',
    approvedAt: '2026-09-22T10:00:00.000Z',
    frozenAt: '2026-09-22T10:05:00.000Z',
    publishedAt: '2026-09-22T10:10:00.000Z',
  }
}

/** Challenge Alpha — a telemetry ingestion and alerting brief. */
export const FIXTURE_RUBRIC_ALPHA: Rubric = build('ch_alpha', 'alpha', fidelityCriteria('alpha', [
  {
    name: 'Ingests the provided telemetry feed',
    description: 'The submission connects to the supplied feed and parses its schema.',
    evidenceSpec:
      'A reader can point to code that opens a connection to the feed and parses records ' +
      'against the documented schema.',
    sourceRef: 'brief §2.1, para 3',
    anchors: anchors(
      'No evidence the feed is consulted.',
      'Referenced in documentation or configuration only.',
      'Connection code is present but unused or non-functional.',
      'Feed is consumed and parsed on the main path.',
      'Feed is consumed, parsed, validated, and failures are handled.',
    ),
  },
  {
    name: 'Detects the threshold breach condition',
    description: 'The rule described in the brief is implemented and evaluated against the feed.',
    evidenceSpec:
      'A reader can point to the comparison implementing the brief’s threshold rule, and to ' +
      'where it is evaluated for each record.',
    sourceRef: 'brief §3.2',
    anchors: anchors(
      'No detection logic.',
      'A placeholder or TODO referencing detection.',
      'A threshold comparison exists but is not applied to feed data.',
      'The rule is implemented and applied to every record.',
      'The rule is implemented, applied, configurable, and covered by a test.',
    ),
  },
  {
    name: 'Raises an alert through the required channel',
    description: 'A detected breach produces an alert via the channel the brief specifies.',
    evidenceSpec:
      'A reader can point to the code path from detection to a dispatched alert, including the ' +
      'channel client or request.',
    sourceRef: 'brief §4.1',
    anchors: anchors(
      'No alerting.',
      'Alerting is described but not implemented.',
      'Alerts are logged locally rather than dispatched.',
      'Alerts are dispatched through the required channel.',
      'Alerts are dispatched with retry and de-duplication as the brief requires.',
    ),
  },
]))

/** Challenge Beta — a document-processing and extraction brief. */
export const FIXTURE_RUBRIC_BETA: Rubric = build('ch_beta', 'beta', fidelityCriteria('beta', [
  {
    name: 'Accepts the specified document formats',
    description: 'The submission ingests each document format named in the brief.',
    evidenceSpec:
      'A reader can point to a parser or library integration for each required format, and to ' +
      'the dispatch that selects between them.',
    sourceRef: 'brief §1.4, table 1',
    anchors: anchors(
      'No document ingestion.',
      'One format is mentioned in documentation only.',
      'One of the required formats is handled.',
      'All required formats are handled on the main path.',
      'All formats handled, with per-file failures reported rather than failing the batch.',
    ),
  },
  {
    name: 'Extracts the required fields',
    description: 'The fields listed in the brief are extracted and structured.',
    evidenceSpec:
      'A reader can point to the extraction logic and to a structure holding each field the ' +
      'brief names.',
    sourceRef: 'brief §2.3',
    anchors: anchors(
      'No extraction.',
      'A data structure exists but nothing populates it.',
      'Some required fields are extracted.',
      'All required fields are extracted on the main path.',
      'All fields extracted, with confidence or provenance recorded per field.',
    ),
  },
]))

export const FIXTURE_RUBRICS: Rubric[] = [FIXTURE_RUBRIC_ALPHA, FIXTURE_RUBRIC_BETA]
