#!/usr/bin/env node
/**
 * `pnpm db:seed:cohort` — a realistic evaluated cohort for local development.
 *
 * Drives the REAL pipeline rather than inserting finished rows: the rubric is created, approved,
 * frozen and published through the rubric service; scores come from the scoring engine; the
 * ranking, the flags and the variance are computed by the same code the event would use. Only
 * two things are substituted — the model, by a deterministic fake, and cloning, by pre-built
 * scan results — because neither should need the network or a provider key to look at a screen.
 *
 * That matters more than convenience. Hand-inserted rows drift from what the pipeline would
 * actually produce, and a development database that disagrees with production behaviour teaches
 * the wrong thing about both.
 *
 * Refuses to run against anything that looks like production.
 */
import { pathToFileURL } from 'node:url'
import { closePool, query } from '../pool.js'
import { loadEnv } from '../../config/env.js'
import { withCorrelation } from '../../lib/correlation.js'
import { installAuditPort } from '../../modules/governance/services/auditService.js'
import { registerProvider, resetProviders } from '../../modules/llm/providers/providerRegistry.js'
import type { ModelProvider, ProviderRequest, ProviderResponse } from '../../modules/llm/providers/providerContract.js'
import { setConfig, setFlag, invalidateConfig } from '../../modules/platform/services/configService.js'
import { createChallenge } from '../../modules/challenges/services/challengeService.js'
import {
  approveRubric, createVersion, freezeRubric, setDimensionWeights,
} from '../../modules/rubrics/services/rubricService.js'
import { publishRubric } from '../../modules/rubrics/services/rubricExport.js'
import { startRun } from '../../modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../modules/scoring/services/rankingService.js'
import { computeVariance } from '../../modules/scoring/services/varianceService.js'
import { decide, openShortlist } from '../../modules/review/services/shortlistService.js'
import { dismissFlag, listFlags } from '../../modules/review/services/flagService.js'
import { TEAMS, CRITERIA, scanFor, probeFor, type Team } from './cohortFixture.js'

/** The CHALLENGE_FIDELITY criteria by name, so a wrong-problem entry can be scored as one. */
const FIDELITY_CRITERIA = ['Ingests the telemetry feed', 'Detects a threshold breach']

const ACTOR = 'organiser@crucible.local'
const COHORT_KEY = 'dev-cohort'
const inScope = <T>(fn: () => Promise<T>) =>
  withCorrelation({ correlationId: 'dev-seed' }, fn)

/**
 * A model that answers from the team's declared quality rather than from a script.
 *
 * Deterministic, so re-seeding produces the same ranking and a screenshot stays true. The small
 * per-criterion variation is what makes the two runs disagree occasionally, which is the whole
 * point of scoring twice — a fake that answered identically would leave the variance screens
 * empty and make them look broken.
 */
class QualityProvider implements ModelProvider {
  readonly name = 'dev-fake'
  isAvailable(): boolean { return true }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const text = `${req.system}\n${req.user}`
    // Matched on the marker comment every fixture file carries, rather than on one file path:
    // the context builder picks whichever files are relevant, and a marker present in only one
    // of them goes missing exactly when the criterion selects a different file.
    const team = TEAMS.find((t) => text.includes(`team: ${t.marker}`))
    const quality = team?.quality ?? 2
    // The jitter is what makes the two runs disagree occasionally, which is the point of
    // scoring twice — a fake that answered identically would leave the variance screens empty
    // and make them look broken.
    const score = clamp(quality + (hash(text) % 3 === 0 ? -1 : 0))

    // A submission that answers a different brief scores low on fidelity and normally
    // everywhere else. One number per team cannot say that, so fidelity is asked for by name.
    const fidelity = team?.fidelity !== undefined && FIDELITY_CRITERIA.some((c) => text.includes(c))
      ? clamp(team.fidelity)
      : score

    if (/"level"/.test(text)) return originality(team)
    if (/"maturity"/.test(text)) return principle(team, score)
    if (/"compliance"/.test(text)) return standard(team, score)
    if (team?.unevidenced === true && /Observability/.test(text)) return unevidenced()
    return criterionScore(team, fidelity)
  }
}

/** The advisory originality signal. */
const originality = (team: Team | undefined): ProviderResponse => respond({
  level: clamp(team?.originality ?? 2),
  insufficient_evidence: false, confidence: 60,
  rationale: 'The application logic outside the scaffold is the team’s own work.',
  observations: ['Most analysed lines are application logic.'],
  evidence: [cite(team)],
})

const principle = (team: Team | undefined, score: number): ProviderResponse => respond({
  maturity: score, insufficient_evidence: false, confidence: 70,
  rationale: 'The practice is applied consistently across the request path.',
  evidence: [cite(team)],
})

const standard = (team: Team | undefined, score: number): ProviderResponse => respond({
  compliance: score >= 3 ? 'COMPLIANT' : score >= 2 ? 'PARTIAL' : 'NON_COMPLIANT',
  insufficient_evidence: false, confidence: 80,
  rationale: 'Checked against the files that were read.',
  evidence: [cite(team)],
})

/**
 * One team's observability criterion, deliberately unevidenced.
 *
 * So the "not enough evidence" path is visible on a screen rather than only in tests — it is
 * the distinction the whole system works to preserve, and it should be there to look at.
 */
const unevidenced = (): ProviderResponse => respond({
  score: null, insufficient_evidence: true, confidence: 10,
  rationale: 'The files read contain nothing bearing on this criterion either way.',
  evidence: [],
})

const criterionScore = (team: Team | undefined, score: number): ProviderResponse => respond({
  score, insufficient_evidence: false, confidence: 60 + score * 8,
  anchor_matched: null,
  rationale: rationaleFor(score),
  evidence: [cite(team)],
  injection_noted: null,
})

export async function main(): Promise<void> {
  const env = loadEnv()
  if (env.NODE_ENV === 'production') {
    console.error('\nREFUSED: db:seed:cohort writes fabricated scores and never runs in production.\n')
    process.exit(2)
  }
  if (!/\/crucible(\?|$)/.test(env.DATABASE_URL)) {
    console.error(
      `\nREFUSED: expected the development database 'crucible', got '${env.DATABASE_URL}'.\n`)
    process.exit(2)
  }

  installAuditPort()
  resetProviders()
  registerProvider(new QualityProvider())

  await clearPrevious()
  invalidateConfig()

  // A cut line that puts a handful of these teams near the boundary, so the review screens have
  // something to work on. Twenty-five would place every one of them safely inside.
  await inScope(() => setConfig('scoring.cut_line', 6, ACTOR))
  await inScope(() => setConfig('scoring.cut_band_size', 2, ACTOR))
  await inScope(() => setFlag('feature.calibration.bypass_gate', true, ACTOR))
  invalidateConfig()

  const challengeId = await seedChallenge()
  const rubricId = await seedRubric(challengeId)
  const submissionIds = await seedSubmissions(challengeId)

  console.log(`\n  scoring ${submissionIds.length} submissions, twice…`)
  const runOne = await scoreCohort(1, submissionIds)
  const runTwo = await scoreCohort(2, submissionIds)

  await computeRanking(runOne, ACTOR)
  await computeRanking(runTwo, ACTOR)
  const variance = await computeVariance(COHORT_KEY)

  await seedReview(runOne)

  console.log(`
  Seeded:
    challenge      ${challengeId}
    rubric         ${rubricId} (frozen and published)
    submissions    ${submissionIds.length}
    score runs     ${runOne} and ${runTwo}
    variance       ${variance.straddling} straddling the cut, ${variance.exceeding} over threshold

  Open  http://127.0.0.1:5180/review/runs/${runOne}
`)
}

/**
 * Remove any previous dev cohort so re-seeding is repeatable rather than cumulative.
 *
 * A frozen rubric cannot be deleted or edited — the E02-S07 triggers refuse both, correctly, and
 * they fire on cascades too. Tearing one down therefore requires disabling those triggers for
 * the duration, which is a HARNESS privilege exactly like the test suite's use of TRUNCATE to
 * clear the append-only audit table: available to a development script, and reachable from
 * nothing in `src/modules`.
 *
 * The application has no path that unfreezes a rubric and must never acquire one. If a frozen
 * rubric needs to change outside a dev seed, the answer is a new version.
 */
async function clearPrevious(): Promise<void> {
  await query(`DELETE FROM score_run WHERE cohort_key = $1`, [COHORT_KEY])
  await query(
    `DELETE FROM submission WHERE challenge_id IN
       (SELECT challenge_id FROM challenge WHERE slug = 'telemetry-triage')`)

  // Three guards stand between a dev seed and a clean slate, and each is correct: the rubric
  // is immutable once frozen, its criteria with it, and the publication record is append-only.
  for (const [table, trigger] of GUARDS) {
    await query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
  }
  try {
    await query(
      `DELETE FROM rubric_publication WHERE rubric_id IN
         (SELECT r.rubric_id FROM rubric r JOIN challenge c USING (challenge_id)
           WHERE c.slug = 'telemetry-triage')`)
    await query(
      `DELETE FROM rubric WHERE challenge_id IN
         (SELECT challenge_id FROM challenge WHERE slug = 'telemetry-triage')`)
    await query(`DELETE FROM challenge WHERE slug = 'telemetry-triage'`)
  } finally {
    // Restored even if the teardown throws: leaving a development database with its
    // immutability guards switched off would make every later test of them meaningless.
    for (const [table, trigger] of GUARDS) {
      await query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  }
}

/** The immutability guards this teardown must step around, and put back. */
const GUARDS: ReadonlyArray<readonly [string, string]> = [
  ['rubric', 'trg_rubric_freeze_guard'],
  ['rubric_criterion', 'trg_criterion_freeze_guard'],
  ['rubric_publication', 'trg_publication_append_only'],
]

async function seedChallenge(): Promise<number> {
  const challenge = await inScope(() => createChallenge({
    name: 'Telemetry Triage',
    actor: ACTOR,
  }))
  await query(
    `UPDATE challenge SET slug = 'telemetry-triage', status = 'OPEN',
            description = $2 WHERE challenge_id = $1`,
    [challenge.challengeId,
     'Build a service that ingests the provided telemetry feed, detects threshold breaches and '
     + 'surfaces them to an operator.'])
  return challenge.challengeId
}

async function seedRubric(challengeId: number): Promise<number> {
  const rubric = await inScope(() => createVersion({
    challengeId, criteria: CRITERIA, actor: ACTOR,
  }))
  const rubricId = Number(rubric.rubricId)

  // The plan's default weights (§II.4).
  await inScope(() => setDimensionWeights(rubricId, {
    CHALLENGE_FIDELITY: 0.30, ENGINEERING_QUALITY: 0.25,
    PRINCIPLES_STANDARDS: 0.20, RUNS: 0.15, ORIGINALITY: 0.10,
  } as never, ACTOR))

  await inScope(() => approveRubric(rubricId, ACTOR, ['NEEDS_REWRITE', 'LOW_CONFIDENCE']))
  await inScope(() => freezeRubric(rubricId, ACTOR))
  await inScope(() => publishRubric(rubricId, ACTOR))
  return rubricId
}

async function seedSubmissions(challengeId: number): Promise<number[]> {
  const ids: number[] = []

  for (const team of TEAMS) {
    const row = await query<{ submission_id: number }>(
      `WITH t AS (
         INSERT INTO team (display_name, contact_email, origin, created_by)
         VALUES ($1, $2, 'ORGANISER', 'seed') RETURNING team_id
       )
       INSERT INTO submission
         (team_id, team_name, contact_email, challenge_id, repo_url, build_method, build_command,
          dockerfile_path, validation_status, locked_commit_sha, submitted_by, submitted_via)
       SELECT t.team_id, $1, $2, $3, $4, $5, $6, $7, 'VALID', $8, $2, 'ORGANISER' FROM t
       RETURNING submission_id`,
      [team.name, team.email, challengeId, team.repoUrl,
       team.dockerfile === null ? 'COMMAND' : 'DOCKERFILE',
       team.dockerfile === null ? 'npm ci && npm run build' : null,
       team.dockerfile, team.sha])
    const submissionId = row.rows[0]!.submission_id
    ids.push(submissionId)

    const scan = scanFor(team)
    await query(
      `INSERT INTO scan (submission_id, depth, raw_result, content_hash, status, languages,
                         primary_language, commit_sha, files_analyzed, files_total,
                         budget_truncated, total_lines, code_lines, has_tests, test_file_count,
                         has_ci, has_dockerfile, has_readme, dependency_count, finished_at)
       VALUES ($1,'standard',$2::jsonb,$3,'COMPLETED',ARRAY['typescript'],'typescript',$4,
               $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
      [submissionId, JSON.stringify(scan), String(submissionId).padStart(64, 'd'), team.sha,
       scan.filesAnalysed, scan.filesTotal, scan.budgetTruncated,
       scan.metrics.totalLines, scan.metrics.codeLines, scan.metrics.hasTests,
       scan.metrics.testFileCount, scan.metrics.hasCi, scan.metrics.hasDockerfile,
       scan.metrics.hasReadme, scan.metrics.dependencyCount])

    const probe = probeFor(team)
    if (probe !== null) {
      await query(
        `INSERT INTO build_probe
           (submission_id, method, outcome, runs_grade, runs_score, grade_reason, exit_code,
            stayed_up, timed_out, resource_exceeded, log, log_truncated, base_image, ran_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,FALSE,$9,FALSE,'node:20-slim', now())`,
        [submissionId, team.dockerfile === null ? 'COMMAND' : 'DOCKERFILE',
         probe.outcome, probe.grade, probe.score, probe.reason, probe.exitCode,
         probe.stayedUp, probe.log])
    }
  }

  return ids
}

async function scoreCohort(runIndex: 1 | 2, submissionIds: number[]): Promise<number> {
  const outcome = await inScope(() => startRun({
    cohortKey: COHORT_KEY, runIndex, submissionIds, startedBy: ACTOR,
  }))
  return outcome.run.run_index_id
}

/**
 * A partly-worked review, so the screens show work in progress rather than a blank slate or a
 * finished job. Two teams decided, one caveat answered, the rest left for whoever opens it.
 */
async function seedReview(runIndexId: number): Promise<void> {
  await openShortlist(runIndexId, ACTOR, COHORT_KEY)

  const top = await query<{ submission_id: number }>(
    `SELECT submission_id FROM submission_composite
      WHERE run_index_id = $1 ORDER BY rank_global LIMIT 2`, [runIndexId])

  for (const [i, row] of top.rows.entries()) {
    await decide({
      runIndexId, submissionId: row.submission_id, decision: 'SHORTLIST',
      reason: i === 0
        ? 'Strongest fidelity evidence in the cohort; the retry path is cited and real.'
        : 'Clear second on the evidence; engineering quality carries it.',
      actor: ACTOR,
    })
  }

  const first = top.rows[0]?.submission_id
  if (first !== undefined) {
    const flags = await listFlags(runIndexId, first)
    const open = flags.find((f) => !f.dismissed)
    if (open) {
      await dismissFlag({
        runIndexId, submissionId: first, code: open.code, actor: 'reviewer@crucible.local',
        reason: 'Checked against the repository; the caveat does not change the placement.',
      })
    }
  }
}

const respond = (body: unknown): ProviderResponse => ({
  text: JSON.stringify(body),
  tokensIn: 1200, tokensOut: 260, stopReason: 'end_turn',
})

/**
 * A citation that is actually true of the fixture repository.
 *
 * It has to be. Since E13 every citation is checked against the scanned source, and a quoted
 * excerpt that appears nowhere in the cited file is CONTRADICTED — so a fixed excerpt invented
 * for this seeder made every LLM-scored criterion in the whole dev cohort unscoreable, silently,
 * while the seed still reported success.
 *
 * The marker comment is the one line every fixture file carries by construction, and it is the
 * first line of the file the criteria are scored against.
 */
const cite = (team: Team | undefined) => {
  const path = team?.marker ?? 'src/index.ts'
  return { path, line_start: 1, line_end: 1, excerpt: `// team: ${path}` }
}

function rationaleFor(score: number): string {
  switch (score) {
    case 4: return 'Implemented, validated, and failures are handled on the path that matters.'
    case 3: return 'Implemented and exercised on the main path; error handling is partial.'
    case 2: return 'Code is present but is not reached by the running path.'
    case 1: return 'Referenced in configuration and documentation only.'
    default: return 'Nothing in the code addresses this.'
  }
}

const clamp = (n: number): number => Math.max(0, Math.min(4, n))

/** Small stable hash, so the same text always produces the same jitter. */
function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return Math.abs(h)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error('\nCohort seed failed:\n', err instanceof Error ? err.message : err)
      await closePool()
      process.exit(1)
    })
}
