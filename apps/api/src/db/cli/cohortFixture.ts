/**
 * The development cohort's teams, rubric and repositories.
 *
 * Separated from the seed script so the data is readable on its own: this is the part somebody
 * edits to make a screen show something different, and it should not require reading the
 * orchestration to do it.
 *
 * The cohort is deliberately uneven. A set of twelve competent submissions makes every screen
 * look calm and proves nothing, so this one contains a scaffold-only entry, one that fails to
 * build, one whose stack has no recipe, one whose scan was truncated, and one criterion nobody
 * can evidence — the cases the review screens exist to make visible.
 */
export type { ProbeShape } from './cohortRepos.js'
export { probeFor, scanFor } from './cohortRepos.js'

export interface Team {
  name: string
  email: string
  repoUrl: string
  sha: string
  dockerfile: string | null
  /** Drives the fake model's scores: 0 is nothing, 4 is complete. */
  quality: number
  originality: number
  /** A marker the fake model recognises in the prompt to identify the team. */
  marker: string
  /** True for the team whose observability criterion cannot be evidenced. */
  unevidenced?: boolean
  shape: 'STRONG' | 'SOLID' | 'PARTIAL' | 'SCAFFOLD' | 'BROKEN' | 'EXOTIC' | 'HUGE'
    | 'WRONG_PROBLEM'
  /**
   * Fidelity, where it differs from overall quality.
   *
   * Only WRONG_PROBLEM needs it: well-built software that answers a different brief. Without
   * this the fake model would score every dimension alike and the edge case would be
   * indistinguishable from a weak submission, which is the opposite of the point.
   */
  fidelity?: number
}

export const TEAMS: Team[] = [
  team({ name: 'Northwind Signals', slug: 'strong', quality: 4, originality: 3,
         marker: 'src/pipeline/ingest.ts', shape: 'STRONG' }),
  team({ name: 'Harbour Metrics', slug: 'solid-a', quality: 3, originality: 3,
         marker: 'src/ingest/feed.ts', shape: 'SOLID' }),
  team({ name: 'Cobalt Works', slug: 'solid-b', quality: 3, originality: 2,
         marker: 'src/telemetry/reader.ts', shape: 'SOLID' }),
  team({ name: 'Fenwick Labs', slug: 'partial-a', quality: 2, originality: 2,
         marker: 'src/reader.ts', shape: 'PARTIAL' }),
  team({ name: 'Pike Street Data', slug: 'partial-b', quality: 2, originality: 3,
         marker: 'src/stream/consume.ts', shape: 'PARTIAL' }),
  team({ name: 'Aldgate Analytics', slug: 'huge', quality: 3, originality: 2,
         marker: 'src/core/ingest.ts', shape: 'HUGE' }),
  team({ name: 'Quayside Systems', slug: 'exotic', quality: 3, originality: 3,
         marker: 'lib/ingest.ex', shape: 'EXOTIC' }),
  team({ name: 'Marlow Telemetry', slug: 'broken', quality: 2, originality: 2,
         marker: 'src/app.ts', shape: 'BROKEN' }),
  team({ name: 'Beacon Collective', slug: 'unevidenced', quality: 3, originality: 2,
         marker: 'src/handler.ts', shape: 'PARTIAL', unevidenced: true }),
  team({ name: 'Ridgeway Digital', slug: 'weak-a', quality: 1, originality: 1,
         marker: 'src/index.ts', shape: 'PARTIAL' }),
  team({ name: 'Copperfield IO', slug: 'scaffold', quality: 0, originality: 0,
         marker: 'src/App.tsx', shape: 'SCAFFOLD' }),
  team({ name: 'Tallow Bridge', slug: 'weak-b', quality: 1, originality: 2,
         marker: 'src/main.ts', shape: 'PARTIAL' }),
  // Answers a different brief, and answers it well. A golden set must span this case: it is
  // where a scorer that rewards polish over relevance goes wrong, and the one edge case the
  // calibration gate requires that this cohort used to lack entirely.
  team({ name: 'Selwyn Row', slug: 'wrong-problem', quality: 3, originality: 3, fidelity: 0,
         marker: 'src/roster/schedule.ts', shape: 'WRONG_PROBLEM' }),
]

interface TeamSpec {
  name: string
  slug: string
  quality: number
  originality: number
  marker: string
  shape: Team['shape']
  fidelity?: number
  unevidenced?: boolean
}

function team(spec: TeamSpec): Team {
  return {
    name: spec.name,
    email: `${spec.slug}@team.test`,
    repoUrl: `https://github.com/crucible-dev/${spec.slug}`,
    sha: spec.slug.padEnd(40, '0').slice(0, 40).replace(/[^a-f0-9]/g, '0'),
    dockerfile: ['STRONG', 'SOLID', 'WRONG_PROBLEM'].includes(spec.shape) ? 'Dockerfile' : null,
    quality: spec.quality,
    originality: spec.originality,
    marker: spec.marker,
    shape: spec.shape,
    ...(spec.fidelity !== undefined ? { fidelity: spec.fidelity } : {}),
    ...(spec.unevidenced === true ? { unevidenced: true } : {}),
  }
}

/** The rubric the committee approved: criteria across four dimensions, Runs stays objective. */
export const CRITERIA = [
  criterion({
    dimension: 'CHALLENGE_FIDELITY', name: 'Ingests the telemetry feed', weight: 0.5,
    evidenceSpec: 'A reader can point at the code that connects to the feed and parses records.',
    sourceRef: 'brief §2.1',
    anchors: [
      'No evidence the feed is consulted.',
      'Referenced in documentation or configuration only.',
      'Connection code present but unused or non-functional.',
      'Feed consumed and parsed on the main path.',
      'Consumed, parsed, validated, with failure handling.',
    ],
  }),
  criterion({
    dimension: 'CHALLENGE_FIDELITY', name: 'Detects a threshold breach', weight: 0.5,
    evidenceSpec: 'A reader can point at the threshold comparison and what happens when it trips.',
    sourceRef: 'brief §2.2',
    anchors: [
      'No breach detection of any kind.',
      'A threshold is configured but never compared against.',
      'Comparison exists but nothing acts on the result.',
      'Breaches are detected and surfaced on the main path.',
      'Breaches are detected, surfaced, and the repeat rule is enforced.',
    ],
  }),
  criterion({
    dimension: 'ENGINEERING_QUALITY', name: 'Handles failure without losing work', weight: 0.6,
    evidenceSpec: 'A reader can point at the retry path and at what happens when it gives up.',
    anchors: [
      'No error handling.',
      'Errors are caught and swallowed.',
      'Retries exist but without backoff.',
      'Retries with backoff on the main path.',
      'Retries with backoff, and exhaustion is surfaced rather than hidden.',
    ],
  }),
  criterion({
    dimension: 'ENGINEERING_QUALITY', name: 'Is tested where it matters', weight: 0.4,
    evidenceSpec: 'A reader can point at tests covering the ingestion and detection paths.',
    anchors: [
      'No tests.',
      'Tests exist but assert nothing meaningful.',
      'Tests cover incidental code only.',
      'The main path is tested.',
      'The main path and its failure modes are tested.',
    ],
  }),
  criterion({
    dimension: 'PRINCIPLES_STANDARDS', name: 'Observability of the running service', weight: 1,
    evidenceSpec: 'A reader can point at structured logging or metrics on the request path.',
    anchors: [
      'Nothing is emitted.',
      'Print statements only.',
      'Logging exists but not on the path that matters.',
      'Structured logging on the main path.',
      'Structured logging and metrics, with correlation across a request.',
    ],
  }),
  criterion({
    dimension: 'ORIGINALITY', name: 'The work is the team’s own', weight: 1,
    evidenceSpec: 'A reader can distinguish the team’s application code from generator output.',
    anchors: [
      'Generator output with nothing added.',
      'Small additions to a scaffold.',
      'A recognisable amount of the team’s own work.',
      'Substantial original work on top of a starting point.',
      'Overwhelmingly the team’s own work.',
    ],
  }),
  criterion({
    dimension: 'RUNS', name: 'Builds and runs', weight: 1,
    evidenceSpec: 'The build probe’s recorded result.',
    anchors: [
      'Does not build.',
      'Builds only after manual intervention.',
      'Builds but does not start.',
      'Builds and starts.',
      'Builds, starts and stays up.',
    ],
  }),
]

interface CriterionSpec {
  dimension: string
  name: string
  weight: number
  evidenceSpec: string
  anchors: string[]
  sourceRef?: string
}

function criterion(spec: CriterionSpec) {
  return {
    name: spec.name,
    description: `Whether the submission ${spec.name.toLowerCase()}.`,
    dimension: spec.dimension as 'CHALLENGE_FIDELITY',
    weight: spec.weight,
    evidenceSpec: spec.evidenceSpec,
    anchors: {
      0: spec.anchors[0]!, 1: spec.anchors[1]!, 2: spec.anchors[2]!,
      3: spec.anchors[3]!, 4: spec.anchors[4]!,
    },
    sortOrder: 0,
    sourceRef: spec.sourceRef ?? null,
  }
}
