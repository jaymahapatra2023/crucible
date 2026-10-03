/**
 * Connecting a ranked repository to the submission the machine scored (E21).
 *
 * `golden_entry.submission_id` is what makes a calibration report possible. The column and
 * `linkSubmission` both existed and **nothing in the application called either**, so a golden
 * set could be built, ranked, sealed and given criteria — and then never produce a report.
 *
 * The existing calibration tests hid it by importing `linkSubmission` from the database layer
 * and calling it directly, which is a door only a test has the key to. Everything here goes
 * through the service an organiser actually reaches.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import {
  addEntry, createGoldenSet, recordRanking, seal,
} from '../../src/modules/calibration/services/goldenSetService.js'
import { linkGoldenSet } from '../../src/modules/calibration/services/goldenSetLink.js'
import { recordCriteria } from '../../src/modules/calibration/services/gateService.js'
import { generateReport } from '../../src/modules/calibration/services/calibrationReport.js'
import { entriesFor } from '../../src/modules/calibration/services/goldenSetService.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
let goldenSetId: number
let runIndexId: number

const FALLBACK = 'Fall back to fully human judging for the whole event.'
const BANDS = ['STRONG', 'STRONG', 'MIDDLING', 'MIDDLING', 'MIDDLING', 'WEAK', 'WEAK', 'WEAK']
const EDGE = [null, null, 'VERY_LARGE', 'WRONG_PROBLEM', null, 'FAILS_TO_BUILD', 'SCAFFOLD_ONLY', null]

/** The repository URLs the cohort fixture submits under, in submission order. */
async function cohortRepos(): Promise<string[]> {
  const res = await query<{ repo_url: string }>(
    'SELECT repo_url FROM submission WHERE submission_id = ANY($1) ORDER BY submission_id',
    [cohort.submissionIds])
  return res.rows.map((r) => r.repo_url)
}

/** Entries pointing at the cohort's repositories — what an organiser would enter. */
async function seedEntries(repos: string[]): Promise<number[]> {
  const ids: number[] = []
  for (const [i, repoUrl] of repos.entries()) {
    const entry = await addEntry({
      goldenSetId, label: `entry-${i}`, repoUrl,
      expectedBand: BANDS[i] ?? 'MIDDLING', edgeCase: EDGE[i] ?? null,
      notes: '', actor: ACTOR,
    })
    ids.push(entry.entry_id)
  }
  return ids
}

const rankAll = (ids: readonly number[], ranker: string) =>
  recordRanking({
    goldenSetId, ranker,
    positions: ids.map((entryId, i) => ({ entryId, position: i + 1, rationale: 'read it' })),
    actor: ranker,
  })

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  provider.setResponder((req) =>
    JSON.stringify(req).includes('ADVISORY') ? originalityTurn(3) : scoreTurn(3))

  cohort = await seedCohort({ count: 8 })
  const outcome = await inScope(() => startRun({
    cohortKey: 'golden-cohort', runIndex: 1,
    submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  runIndexId = outcome.run.run_index_id
  await computeRanking(runIndexId, ACTOR)

  const set = await createGoldenSet({
    name: 'Calibration set', description: 'Eight repositories.', actor: ACTOR,
  })
  goldenSetId = Number(set.golden_set_id)
})

afterEach(() => { restoreProviders(); resetGateway() })

describe('the plan, before anything is written', () => {
  it('matches every entry to its submission by repository', async () => {
    await seedEntries(await cohortRepos())
    const plan = await linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR })

    expect(plan.summary).toMatchObject({ total: 8, resolved: 8, unresolved: 0 })
    expect(plan.rows.every((r) => r.outcome === 'MATCHED')).toBe(true)
    expect(plan.rows[0]!.teamName).toBeTruthy()
  })

  it('writes NOTHING until it is confirmed', async () => {
    await seedEntries(await cohortRepos())
    await linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR })

    const entries = await entriesFor(goldenSetId)
    expect(entries.every((e) => e.submission_id === null)).toBe(true)
  })

  it('names an entry no submission points at, and says what to do', async () => {
    const repos = await cohortRepos()
    await seedEntries([...repos.slice(0, 7), 'https://github.com/golden/never-submitted'])

    const plan = await linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR })
    const missing = plan.rows.find((r) => r.repoUrl.includes('never-submitted'))!
    expect(missing.outcome).toBe('NO_SUBMISSION')
    expect(missing.detail).toMatch(/scanned, probed and scored by the same path/)
  })

  it('reports an entry whose URL this system would not accept', async () => {
    const repos = await cohortRepos()
    await seedEntries([...repos.slice(0, 7), 'not-a-url'])

    const plan = await linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR })
    expect(plan.rows.find((r) => r.repoUrl === 'not-a-url')!.outcome).toBe('UNREADABLE')
  })

  it('REFUSES to guess when two submissions point at the same repository', async () => {
    // Two teams entering the same repository is possible, and picking one would put a guess
    // into the evidence the gate rests on.
    const repos = await cohortRepos()
    await query(
      `UPDATE submission SET repo_url = $1 WHERE submission_id = $2`,
      [repos[0], cohort.submissionIds[1]])
    await seedEntries(repos)

    const plan = await linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR })
    const ambiguous = plan.rows.filter((r) => r.outcome === 'AMBIGUOUS')
    expect(ambiguous.length).toBeGreaterThan(0)
    expect(ambiguous[0]!.detail).toMatch(/Resolve which one/)
  })

  it('matches on the CANONICAL url, not the typed one', async () => {
    // Intake stores the canonicalised clone URL, so an entry typed with a .git suffix or a
    // trailing slash is the same repository and has to be treated as one.
    const repos = await cohortRepos()
    await seedEntries([`${repos[0]}.git`, ...repos.slice(1)])

    const plan = await linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR })
    expect(plan.rows[0]!.outcome).toBe('MATCHED')
  })

  it('REFUSES to guess when the same repository is entered on two challenges (E26)', async () => {
    // A golden set rebuilt against a revised rubric produces exactly this: the same repository
    // submitted twice, once per challenge. A URL then identifies a repository but not which
    // submission of it the set means.
    const repos = await cohortRepos()
    const second = await query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, status) VALUES ('Second', 'second-ch', 'OPEN')
       RETURNING challenge_id`)
    await query(
      `INSERT INTO submission (team_id, team_name, contact_email, challenge_id, repo_url,
                               build_method, build_command, validation_status)
       SELECT team_id, team_name || ' again', contact_email, $1, repo_url, build_method,
              build_command, 'VALID'
         FROM submission WHERE submission_id = $2`,
      [second.rows[0]!.challenge_id, cohort.submissionIds[0]])

    await seedEntries(repos)
    const plan = await linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR })
    expect(plan.rows[0]!.outcome).toBe('AMBIGUOUS')
  })

  it('resolves it when the search is narrowed to one challenge (E26)', async () => {
    const repos = await cohortRepos()
    const second = await query<{ challenge_id: number }>(
      `INSERT INTO challenge (name, slug, status) VALUES ('Second', 'second-ch', 'OPEN')
       RETURNING challenge_id`)
    await query(
      `INSERT INTO submission (team_id, team_name, contact_email, challenge_id, repo_url,
                               build_method, build_command, validation_status)
       SELECT team_id, team_name || ' again', contact_email, $1, repo_url, build_method,
              build_command, 'VALID'
         FROM submission WHERE submission_id = $2`,
      [second.rows[0]!.challenge_id, cohort.submissionIds[0]])

    await seedEntries(repos)
    const plan = await linkGoldenSet({
      goldenSetId, challengeId: cohort.challengeId, confirm: false, actor: ACTOR,
    })
    expect(plan.rows.every((r) => r.outcome === 'MATCHED')).toBe(true)
  })

  it('says WHICH challenge it searched when narrowing found nothing', async () => {
    const repos = await cohortRepos()
    await seedEntries(repos)
    const plan = await linkGoldenSet({
      goldenSetId, challengeId: 999_999, confirm: false, actor: ACTOR,
    })
    expect(plan.rows[0]!.outcome).toBe('NO_SUBMISSION')
    expect(plan.rows[0]!.detail).toMatch(/challenge 999999/)
  })

  it('refuses a set with no entries at all', async () => {
    await expect(linkGoldenSet({ goldenSetId, confirm: false, actor: ACTOR }))
      .rejects.toThrow(/no entries to link/)
  })
})

describe('linking', () => {
  it('records the link, and the report can then be produced', async () => {
    // The assertion this whole file exists for: the gate reached through the application.
    const ids = await seedEntries(await cohortRepos())
    await linkGoldenSet({ goldenSetId, confirm: true, actor: ACTOR })

    await rankAll(ids, 'alice@test.local')
    await rankAll(ids, 'bob@test.local')
    await seal(goldenSetId, ACTOR)
    await recordCriteria({
      goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1, materialRankGap: 3,
      maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '', actor: ACTOR,
    })

    const report = await generateReport({ goldenSetId, runIndexId, actor: ACTOR })
    expect(report.sample_size).toBe(8)
    expect(report).toHaveProperty('rank_correlation')
  })

  it('reports the weakest dimension even when some entries could not be scored', async () => {
    // A golden set spans a scaffold and a repository that will not build precisely so that some
    // dimensions cannot be scored for every entry. Requiring all of them excluded every
    // dimension, so E11-S02's weakest-dimension finding never appeared on a realistic set.
    const ids = await seedEntries(await cohortRepos())
    await linkGoldenSet({ goldenSetId, confirm: true, actor: ACTOR })

    // UNSCORED is the honest state for a dimension nothing could be evidenced against, and the
    // CHECK constraint ties it to a null score — so the fixture sets both, as the scorer would.
    await query(
      `UPDATE submission_dimension_score SET score = NULL, data_quality = 'UNSCORED'
        WHERE run_index_id = $1 AND submission_id = $2`,
      [runIndexId, cohort.submissionIds[0]])

    await rankAll(ids, 'alice@test.local')
    await rankAll(ids, 'bob@test.local')
    await seal(goldenSetId, ACTOR)
    await recordCriteria({
      goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1, materialRankGap: 3,
      maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '', actor: ACTOR,
    })

    const report = await generateReport({ goldenSetId, runIndexId, actor: ACTOR })
    const detail = report.detail as { dimensions: Array<{ dimension: string }> }
    expect(detail.dimensions.length).toBeGreaterThan(0)
  })

  it('REFUSES THE WHOLE SET when any entry is unresolved', async () => {
    // A report over seven of the eight repositories the committee ranked is not a report about
    // this golden set, and the correlation would carry its name while answering another question.
    const repos = await cohortRepos()
    await seedEntries([...repos.slice(0, 7), 'https://github.com/golden/never-submitted'])

    const plan = await linkGoldenSet({ goldenSetId, confirm: true, actor: ACTOR })
    expect(plan.linked).toBe(false)
    expect(plan.refusal).toMatch(/Nothing was linked/)

    const entries = await entriesFor(goldenSetId)
    expect(entries.every((e) => e.submission_id === null)).toBe(true)
  })

  it('is permitted AFTER sealing — scoring necessarily happens after the human judgement', async () => {
    const ids = await seedEntries(await cohortRepos())
    await rankAll(ids, 'alice@test.local')
    await rankAll(ids, 'bob@test.local')
    await seal(goldenSetId, ACTOR)

    const plan = await linkGoldenSet({ goldenSetId, confirm: true, actor: ACTOR })
    expect(plan.linked).toBe(true)
  })

  it('is idempotent — running it twice does not relink or complain', async () => {
    await seedEntries(await cohortRepos())
    await linkGoldenSet({ goldenSetId, confirm: true, actor: ACTOR })

    const again = await linkGoldenSet({ goldenSetId, confirm: true, actor: ACTOR })
    expect(again.rows.every((r) => r.outcome === 'ALREADY_LINKED')).toBe(true)
    expect(again.summary.unresolved).toBe(0)
  })

  it('records the pairs in the audit trail', async () => {
    await seedEntries(await cohortRepos())
    await linkGoldenSet({ goldenSetId, confirm: true, actor: ACTOR })

    const audit = await query<{ payload: { linked: number } }>(
      `SELECT payload FROM audit_event WHERE action = 'calibration.entries_linked'`)
    expect(audit.rows[0]!.payload.linked).toBe(8)
  })
})
