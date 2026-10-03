/**
 * Fixtures for scoring tests (E06).
 *
 * Builds the state a scoring run needs — a challenge, a frozen rubric, submissions and persisted
 * scans with real file content — so each test can be about the scoring behaviour rather than
 * about assembling twenty rows of setup.
 */
import type { ScanResult, ScannedFile } from '@crucible/scanner'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import { createChallenge } from '../../src/modules/challenges/services/challengeService.js'
import {
  approveRubric, createVersion, freezeRubric, setDimensionWeights,
} from '../../src/modules/rubrics/services/rubricService.js'

export const ACTOR = 'organiser@test.local'
export const inScope = <T>(fn: () => Promise<T>) =>
  withCorrelation({ correlationId: 'scoring-test' }, fn)

export function scannedFile(path: string, content: string, language = 'typescript'): ScannedFile {
  return {
    path, content, language,
    bytes: content.length,
    lines: content.split('\n').length,
    truncated: false,
  }
}

/** Source that a criterion about retries and error handling can actually be judged from. */
export const RESILIENCE_SOURCE = scannedFile('src/retry.ts', [
  'export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {',
  '  let lastError: unknown',
  '  for (let attempt = 0; attempt < attempts; attempt++) {',
  '    try {',
  '      return await fn()',
  '    } catch (error) {',
  '      lastError = error',
  '      await delay(backoff(attempt))',
  '    }',
  '  }',
  '  throw lastError',
  '}',
].join('\n'))

export function scanResult(files: ScannedFile[], overrides: Partial<ScanResult> = {}): ScanResult {
  const totalLines = files.reduce((sum, f) => sum + f.lines, 0)
  return {
    commitSha: 'a'.repeat(40),
    headCommittedAt: '2026-01-01T00:00:00Z',
    files,
    stats: {
      totalFiles: files.length, sourceFiles: files.length,
      totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      byLanguage: {}, topDirectories: ['src'], recommendedDepth: 'standard',
    },
    metrics: {
      filesAnalysed: files.length, totalLines, codeLines: totalLines,
      commentLines: 0, blankLines: 0, languages: ['typescript'], longFiles: [],
      maxFileLines: Math.max(0, ...files.map((f) => f.lines)),
      averageFileLines: files.length === 0 ? 0 : Math.round(totalLines / files.length),
      hasTests: false, testFileCount: 0, hasCi: false, hasDockerfile: false,
      hasReadme: false, hasLockfile: false, dependencyCount: 0,
    },
    provenance: null,
    filesAnalysed: files.length, filesTotal: files.length,
    budgetTruncated: false,
    scannedAt: '2026-01-01T00:00:00Z', durationMs: 5,
    ...overrides,
  }
}

let sequence = 0

export async function seedSubmission(challengeId: number): Promise<number> {
  sequence++
  const row = await query<{ submission_id: number }>(
    `WITH t AS (
       INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ($1, $2, 'ORGANISER', 'fixture') RETURNING team_id
     )
     INSERT INTO submission
       (team_id, team_name, contact_email, challenge_id, repo_url, build_method, build_command,
        validation_status, locked_commit_sha)
     SELECT t.team_id, $1, $2, $3, $4, 'COMMAND', 'npm ci', 'VALID', $5 FROM t
     RETURNING submission_id`,
    // A scored submission has had its commit locked at the deadline; the fixture matches, so
    // tests about what a team was judged on are not testing an unrealistic row.
    [`Team ${sequence}`, `team${sequence}@test.local`, challengeId,
     `https://github.com/example/repo-${sequence}`,
     String(sequence).padStart(40, 'a')])
  return row.rows[0]!.submission_id
}

/**
 * Persist a scan the way the scanner does.
 *
 * The coverage columns are written from the same `ScanResult` that goes into `raw_result`, not
 * left at their defaults: `v_scans_coverage` reads the columns, so a fixture that populated only
 * the JSON would report full coverage for a repository that was truncated — and the flag that
 * depends on it would never fire.
 */
export async function seedScan(submissionId: number, result: ScanResult): Promise<void> {
  await query(
    `INSERT INTO scan (submission_id, depth, raw_result, content_hash, status,
                       languages, primary_language, commit_sha,
                       files_analyzed, files_total, budget_truncated,
                       total_lines, code_lines, has_tests, has_ci, has_dockerfile,
                       has_readme, dependency_count, finished_at)
     VALUES ($1, 'standard', $2::jsonb, $3, 'COMPLETED', ARRAY['typescript'],
             'typescript', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())`,
    [submissionId, JSON.stringify(result),
     String(submissionId).padStart(64, 'b'), result.commitSha ?? 'c'.repeat(40),
     result.filesAnalysed, result.filesTotal, result.budgetTruncated,
     result.metrics.totalLines, result.metrics.codeLines, result.metrics.hasTests,
     result.metrics.hasCi, result.metrics.hasDockerfile, result.metrics.hasReadme,
     result.metrics.dependencyCount])
}

export interface CohortFixture {
  challengeId: number
  rubricId: number
  submissionIds: number[]
}

/**
 * A challenge with a frozen rubric and `count` scanned submissions.
 *
 * The rubric puts all weight on challenge fidelity by default so a test asserting on one
 * criterion is not also asserting on four dimensions it did not set up.
 */
export async function seedCohort(options: {
  count: number
  files?: ScannedFile[]
  name?: string
  weights?: Record<string, number>
  criteria?: Array<{ name: string; dimension: string; weight: number }>
}): Promise<CohortFixture> {
  const challenge = await inScope(() =>
    createChallenge({ name: options.name ?? `Challenge ${Date.now()}-${sequence}`, actor: ACTOR }))
  const challengeId = challenge.challengeId

  const criteria = (options.criteria ?? [
    { name: 'Handles failures without losing work', dimension: 'CHALLENGE_FIDELITY', weight: 1 },
  ]).map((c, index) => ({
    name: c.name,
    description: `Whether the submission ${c.name.toLowerCase()}.`,
    dimension: c.dimension as 'CHALLENGE_FIDELITY',
    weight: c.weight,
    evidenceSpec: 'A reader can point at the retry loop, the backoff and the error handling.',
    anchors: {
      0: 'No evidence of retries or error handling.',
      1: 'Errors are caught but swallowed.',
      2: 'Retries exist but without backoff.',
      3: 'Retries with backoff on the main path.',
      4: 'Retries with backoff, and failures are surfaced.',
    },
    sourceRef: 'brief §1',
    sortOrder: index,
  }))

  const rubric = await inScope(() => createVersion({ challengeId, criteria, actor: ACTOR }))
  const rubricId = Number(rubric.rubricId)

  await inScope(() => setDimensionWeights(rubricId, {
    CHALLENGE_FIDELITY: 1, ENGINEERING_QUALITY: 0, PRINCIPLES_STANDARDS: 0,
    RUNS: 0, ORIGINALITY: 0,
    ...options.weights,
  } as never, ACTOR))
  // Warnings are acknowledged rather than avoided: these fixtures are about scoring, and a
  // rubric that trips a quality warning still freezes once a human has owned that decision.
  await inScope(() => approveRubric(rubricId, ACTOR, ['NEEDS_REWRITE', 'LOW_CONFIDENCE']))
  await inScope(() => freezeRubric(rubricId, ACTOR))

  const submissionIds: number[] = []
  for (let i = 0; i < options.count; i++) {
    const submissionId = await seedSubmission(challengeId)
    await seedScan(submissionId, scanResult(options.files ?? [RESILIENCE_SOURCE]))
    submissionIds.push(submissionId)
  }

  return { challengeId, rubricId, submissionIds }
}

/** A scripted criterion score, as the model would return it. */
export const scoreTurn = (score: number, path = 'src/retry.ts') => ({
  text: JSON.stringify({
    score,
    insufficient_evidence: false,
    confidence: 80,
    anchor_matched: 'Retries with backoff on the main path.',
    rationale: 'A retry loop with exponential backoff is present and used on the main path.',
    evidence: [{ path, line_start: 1, line_end: 12, excerpt: 'export async function withRetry' }],
    injection_noted: null,
  }),
})

export const insufficientTurn = () => ({
  text: JSON.stringify({
    score: null,
    insufficient_evidence: true,
    confidence: 10,
    rationale: 'The excerpts do not show whether this is handled.',
    evidence: [],
  }),
})

export const principleTurn = (maturity: number) => ({
  text: JSON.stringify({
    maturity,
    insufficient_evidence: false,
    confidence: 70,
    rationale: 'The retry helper is used consistently across the request path.',
    evidence: [{ path: 'src/retry.ts', line_start: 1, line_end: 12, excerpt: 'withRetry' }],
  }),
})

export const standardTurn = (compliance: string) => ({
  text: JSON.stringify({
    compliance,
    insufficient_evidence: false,
    confidence: 90,
    rationale: 'No credential literals appear in the analysed files.',
    evidence: [{ path: 'src/retry.ts', line_start: 1, line_end: 3, excerpt: 'export async' }],
  }),
})

export const originalityTurn = (level: number) => ({
  text: JSON.stringify({
    level,
    insufficient_evidence: false,
    confidence: 60,
    rationale: 'The retry helper and its callers are the team’s own work.',
    observations: ['Most of the analysed lines are application logic.'],
    evidence: [{ path: 'src/retry.ts', line_start: 1, line_end: 12, excerpt: 'withRetry' }],
  }),
})
