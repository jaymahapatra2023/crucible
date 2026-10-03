/**
 * What each development team's repository looks like to the scanner and the prober.
 *
 * Split from `cohortFixture.ts` when that file outgrew its size limit. The division is by
 * subject: that file says who the teams are and what they are judged against; this one says
 * what their code looks like.
 */
import type { ScanResult, ScannedFile } from '@crucible/scanner'
import type { Team } from './cohortFixture.js'

/** A scan shaped by what kind of submission this is. */
export function scanFor(team: Team): ScanResult {
  const files = filesFor(team)
  const totalLines = files.reduce((sum, f) => sum + f.lines, 0)
  const truncated = team.shape === 'HUGE'

  return {
    commitSha: team.sha,
    headCommittedAt: '2026-05-16T21:40:00Z',
    depth: 'standard',
    files,
    markers: {
      hasReadme: team.shape !== 'SCAFFOLD',
      hasLockfile: true, lockfiles: ['package-lock.json'],
      hasCi: team.quality >= 3, ciSystems: team.quality >= 3 ? ['github-actions'] : [],
      hasDockerfile: team.dockerfile !== null,
      dockerfilePaths: team.dockerfile === null ? [] : [team.dockerfile],
      hasDockerCompose: false, hasLicense: team.quality >= 3, hasGitignore: true,
    },
    stats: {
      totalFiles: files.length, sourceFiles: files.length,
      totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      byLanguage: {}, topDirectories: ['src'], recommendedDepth: 'standard',
    },
    metrics: {
      filesAnalysed: files.length, totalLines, codeLines: Math.round(totalLines * 0.8),
      commentLines: Math.round(totalLines * 0.12), blankLines: Math.round(totalLines * 0.08),
      languages: team.shape === 'EXOTIC' ? ['elixir'] : ['typescript'],
      longFiles: [], maxFileLines: Math.max(0, ...files.map((f) => f.lines)),
      averageFileLines: files.length === 0 ? 0 : Math.round(totalLines / files.length),
      hasTests: team.quality >= 3, testFileCount: team.quality >= 3 ? 6 : 0,
      hasCi: team.quality >= 3, hasDockerfile: team.dockerfile !== null,
      hasReadme: team.shape !== 'SCAFFOLD', hasLockfile: true, dependencyCount: 14,
    },
    provenance: team.quality === 0
      ? null
      : {
          firstCommitAt: '2026-05-16T09:00:00Z', lastCommitAt: '2026-05-16T21:40:00Z',
          totalCommits: 10 + team.quality * 6, commitsInWindow: 10 + team.quality * 6,
          commitsOutOfWindow: team.shape === 'HUGE' ? 22 : 0,
          distinctAuthors: 2 + (team.quality > 2 ? 2 : 0), authors: [],
          largestSingleCommitPct: 34,
          historyTruncated: false,
        },
    filesAnalysed: files.length,
    filesTotal: truncated ? 940 : files.length,
    budgetTruncated: truncated,
    scannedAt: '2026-05-17T02:00:00Z',
    durationMs: 4200,
  }
}

/**
 * A repository shaped by how good the team is.
 *
 * Every file carries a `team:` marker comment. The development model identifies whose work it
 * is looking at from the excerpt it was given, and a marker that appears only in one file goes
 * missing whenever the context builder selects a different one — which showed up as whole
 * dimensions reading "not scored" for fixture reasons rather than real ones.
 *
 * The files are also deliberately wordy about retries, logging and tests, because the context
 * builder selects evidence by matching the criterion's terms against file contents. A repository
 * too small to contain the words a criterion asks about produces an honest "no evidence" — true
 * of these fixtures, misleading as a picture of a real cohort.
 */
function filesFor(team: Team): ScannedFile[] {
  const mark = `// team: ${team.marker}`

  if (team.shape === 'SCAFFOLD') {
    // Nothing but generator output: no retries, no logging, no tests. Every dimension but
    // originality is honestly unscoreable, which is the point of having this entry.
    return [
      file('package.json', `{ "name": "app", "dependencies": { "react": "^18" } }`),
      file('src/App.tsx', `${mark}\nexport default function App() { return <div>Vite + React</div> }`),
      file('src/reportWebVitals.ts', 'export const reportWebVitals = () => {}'),
      file('vite.config.ts', 'import { defineConfig } from "vite"\nexport default defineConfig({})'),
      file('src/vite-env.d.ts', '/// <reference types="vite/client" />'),
    ]
  }

  if (team.shape === 'WRONG_PROBLEM') {
    // Careful, tested, well-structured — and about ward rotas rather than the telemetry feed
    // the brief asked for. Nothing here bears on CHALLENGE_FIDELITY, which is exactly what a
    // scorer that rewards polish over relevance gets wrong.
    return [
      file(team.marker, [
        mark,
        'import { createLogger } from "../log"',
        '',
        'const log = createLogger("roster")',
        '',
        '/** Builds a fair shift rota across the nurses available in a period. */',
        'export function buildRota(nurses: Nurse[], shifts: Shift[]): Assignment[] {',
        '  const assignments: Assignment[] = []',
        '  for (const shift of shifts.sort(byStart)) {',
        '    const candidate = leastRecentlyWorked(nurses, assignments, shift)',
        '    if (!candidate) { log.warn("shift unfilled", { shift: shift.id }); continue }',
        '    assignments.push({ shift: shift.id, nurse: candidate.id })',
        '  }',
        '  return assignments',
        '}',
      ].join('\n')),
      file('src/roster/fairness.ts', [
        mark,
        'export function leastRecentlyWorked(nurses: Nurse[], prior: Assignment[], shift: Shift) {',
        '  return nurses',
        '    .filter((n) => isAvailable(n, shift))',
        '    .sort((a, b) => lastWorked(prior, a) - lastWorked(prior, b))[0]',
        '}',
      ].join('\n')),
      file('src/roster/schedule.test.ts', [
        mark,
        'describe("buildRota", () => {',
        '  it("never assigns a nurse two overlapping shifts", () => { /* ... */ })',
        '  it("spreads unpopular shifts evenly across the period", () => { /* ... */ })',
        '})',
      ].join('\n')),
      file('src/log.ts', 'export const createLogger = (name: string) => console'),
      file('README.md', '# Ward rota builder\n\nGenerates a fair shift rota for a ward.'),
      file('Dockerfile', 'FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "dist/index.js"]'),
    ]
  }

  const files: ScannedFile[] = [
    // The ingestion path: what CHALLENGE_FIDELITY asks about.
    file(team.marker, [
      mark,
      'import { createLogger } from "./log"',
      'import { withRetry } from "./retry"',
      '',
      'const log = createLogger("ingest")',
      '',
      '/** Connects to the telemetry feed and parses every record it receives. */',
      'export async function consumeFeed(feed: TelemetryFeed) {',
      '  for await (const record of feed.stream()) {',
      '    const reading = parseReading(record)',
      '    if (reading.value > threshold(reading.metric)) {',
      '      await withRetry(() => raiseBreach(reading))',
      '      log.info("threshold breach detected", { metric: reading.metric })',
      '    }',
      '  }',
      '}',
    ].join('\n')),
  ]

  // ENGINEERING_QUALITY: the retry and error-handling path.
  files.push(file('src/retry.ts', [
    mark,
    'export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {',
    '  let lastError: unknown',
    '  for (let attempt = 0; attempt < attempts; attempt++) {',
    '    try {',
    '      return await fn()',
    '    } catch (error) {',
    '      lastError = error',
    team.quality >= 3
      ? '      await delay(backoff(attempt))   // exponential backoff between attempts'
      : '      // no backoff: retried immediately',
    '    }',
    '  }',
    team.quality >= 3
      ? '  throw new RetriesExhausted("every attempt failed", { cause: lastError })'
      : '  return undefined as T   // failure swallowed',
    '}',
  ].join('\n')))

  // PRINCIPLES_STANDARDS: observability on the request path.
  files.push(file('src/log.ts', [
    mark,
    team.quality >= 3
      ? 'import { correlationId } from "./correlation"'
      : '',
    '/** Structured logging emitted on the request path. */',
    'export const createLogger = (module: string) => ({',
    team.quality >= 3
      ? '  info: (msg: string, fields = {}) => emit({ module, msg, correlationId(), ...fields }),'
      : '  info: (msg: string) => console.log(module, msg),',
    '})',
  ].filter(Boolean).join('\n')))

  if (team.quality >= 3) {
    files.push(file('tests/ingest.test.ts', [
      mark,
      'describe("the ingestion path", () => {',
      '  it("parses a reading and detects a breach", async () => {',
      '    await consumeFeed(sampleFeed)',
      '    expect(raiseBreach).toHaveBeenCalled()',
      '  })',
      '',
      '  it("retries a failed breach and surfaces exhaustion", async () => {',
      '    await expect(consumeFeed(failingFeed)).rejects.toThrow(RetriesExhausted)',
      '  })',
      '})',
    ].join('\n')))
  }

  if (team.quality <= 1) {
    files.push(file('src/todo.ts', `${mark}\n// TODO: handle errors properly\nexport const todo = true`))
  }

  files.push(file('README.md', [
    `# ${team.name}`,
    '',
    'Telemetry triage entry. Consumes the provided feed, detects threshold breaches and',
    'surfaces them to an operator.',
  ].join('\n')))

  return files
}

function file(path: string, content: string): ScannedFile {
  return {
    path, content,
    language: path.endsWith('.ex') ? 'elixir' : 'typescript',
    bytes: content.length,
    lines: content.split('\n').length,
    truncated: false,
  }
}

export interface ProbeShape {
  outcome: string
  grade: string
  score: number
  reason: string
  exitCode: number | null
  stayedUp: boolean
  log: string
}

/**
 * The build probe's result, or null for the team that was never probed.
 *
 * `outcome` and `runs_grade` use the vocabularies the schema actually declares — they are not
 * the same list, and a negative `runs_score` is how E05-S04 says "excluded from the denominator"
 * rather than "scored zero".
 */
export function probeFor(team: Team): ProbeShape | null {
  switch (team.shape) {
    case 'BROKEN':
      return {
        outcome: 'BUILD_FAILED', grade: 'FAILS_TO_BUILD', score: 0,
        reason: 'The build command exited 1.', exitCode: 1, stayedUp: false,
        log: 'npm ERR! Missing script: "build"\nnpm ERR! A complete log is above.',
      }
    case 'EXOTIC':
      return {
        // A harness limitation, not the team's fault: excluded rather than scored.
        outcome: 'UNSUPPORTED_STACK', grade: 'UNSUPPORTED', score: -1,
        reason: 'No build recipe is configured for Elixir.', exitCode: null, stayedUp: false,
        log: 'No base image matched the detected primary language.',
      }
    case 'SCAFFOLD':
      // Never probed at all, so the Runs dimension is left out of the composite entirely.
      return null
    // WRONG_PROBLEM builds and runs perfectly well. That is the point: nothing mechanical
    // catches a submission that answers a different brief.
    case 'STRONG':
    case 'SOLID':
    case 'WRONG_PROBLEM':
      return {
        outcome: 'RUNS', grade: 'RUNS', score: 4,
        reason: 'The image built and the container was still up after the settle period.',
        exitCode: 0, stayedUp: true,
        log: 'Step 8/8 : CMD ["node", "dist/index.js"]\nServer listening on :8080',
      }
    default:
      return {
        outcome: 'BUILDS_ONLY', grade: 'BUILDS_ONLY', score: 3,
        reason: 'The build command exited 0; staying up was not observed.',
        exitCode: 0, stayedUp: false,
        log: 'added 214 packages in 9s\nbuild complete',
      }
  }
}
