/**
 * The scoring engine against a real database (E06-S01 … E06-S05).
 *
 * The model is substituted through the provider registry, so every layer below it — prompt
 * resolution, schema validation, the retry ladder, persistence and the audit trail — runs for
 * real. What these tests exist to prove is the behaviour the whole epic turns on: an unscoreable
 * criterion is recorded as unscoreable, never as a zero.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { loadRubric } from '../../src/modules/rubrics/services/rubricService.js'
import { scoreSubmission } from '../../src/modules/scoring/services/submissionScorer.js'
import { insertScoreRun, selectScoresFor } from '../../src/modules/scoring/db/scoringDb.js'
import {
  selectPrincipleAssessments, selectStandardAssessments,
} from '../../src/modules/scoring/db/principlesDb.js'
import { selectOriginality } from '../../src/modules/scoring/db/originalityDb.js'
import { query } from '../../src/db/pool.js'

/**
 * The database constraint a statement violated.
 *
 * The pool translates constraint violations into an `AppError` with a readable message, so
 * matching on the message would only prove the translation happened. The driver error is kept
 * as the cause, and that is what names the constraint actually enforced.
 */
async function violatedConstraint(sql: string, params: unknown[]): Promise<string | undefined> {
  try {
    await query(sql, params)
    return undefined
  } catch (err) {
    return (err as { cause?: { constraint?: string } }).cause?.constraint
  }
}
import {
  ACTOR, inScope, insufficientTurn, originalityTurn, principleTurn, scanResult, scannedFile,
  scoreTurn, seedCohort, seedScan, standardTurn, RESILIENCE_SOURCE,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let runIndexId: number

async function newRun(cohortKey: string): Promise<number> {
  const run = await insertScoreRun({
    runIndex: 1, cohortKey, rubricVersions: {}, model: 'fake',
    ledgerRunId: null, startedBy: ACTOR,
  })
  return run.run_index_id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  runIndexId = await newRun(`cohort-${Date.now()}`)
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('criterion scoring (E06-S02)', () => {
  it('records the score, rationale, evidence and the rubric it ran under', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3)])

    const rubric = await loadRubric(cohort.rubricId)
    const summary = await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!, rubric,
    }))

    expect(summary.scored).toBe(1)

    const [score] = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
    expect(score?.raw_score).toBe(3)
    expect(score?.non_score).toBeNull()
    expect(score?.evidence[0]?.path).toBe('src/retry.ts')
    expect(score?.rubric_id).toBe(cohort.rubricId)
    expect(score?.rubric_version).toBe(rubric.version)
    expect(score?.rubric_hash).toHaveLength(64)
  })

  it('supplies the anchors VERBATIM in the prompt (acceptance 2)', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(4)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const prompt = JSON.stringify(provider.requests[0])
    expect(prompt).toContain('Retries with backoff, and failures are surfaced.')
    expect(prompt).toContain('No evidence of retries or error handling.')
  })

  it('passes real source with line numbers, not a summary (E06-S01 acceptance 1)', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const prompt = JSON.stringify(provider.requests[0])
    expect(prompt).toContain('withRetry')
    expect(prompt).toContain('src/retry.ts:')
  })

  it('records the context budget it used (acceptance 3)', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const [score] = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
    expect(score?.context_bytes).toBeGreaterThan(0)
    expect(score?.files_searched).toBeGreaterThan(0)
  })
})

describe('the rule the whole epic turns on: a non-score is never a zero', () => {
  it('records INSUFFICIENT_EVIDENCE when no file relates to the criterion (E06-S01 #4)', async () => {
    // A repository about something else entirely: nothing to judge retries by.
    const cohort = await seedCohort({ count: 1, files: [scannedFile('README.md', '# A project')] })
    await query('DELETE FROM scan WHERE submission_id = $1', [cohort.submissionIds[0]!])
    await seedScan(cohort.submissionIds[0]!, scanResult([
      scannedFile('docs/overview.md', 'This document describes the colour palette.'),
    ]))

    const summary = await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    expect(summary.insufficient).toBe(1)
    expect(summary.scored).toBe(0)

    const [score] = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
    expect(score?.raw_score).toBeNull()
    expect(score?.non_score).toBe('INSUFFICIENT_EVIDENCE')
    // No criterion call was needed: we knew we had nothing to show it. (Other dimensions may
    // still call — the claim here is specifically that an unevidenced criterion costs nothing.)
    expect(provider.requests.map((r) => JSON.stringify(r)).filter((r) => r.includes('ANCHORS')))
      .toHaveLength(0)
  })

  it('names the terms it searched for, so the gap is actionable', async () => {
    const cohort = await seedCohort({ count: 1 })
    await query('DELETE FROM scan WHERE submission_id = $1', [cohort.submissionIds[0]!])
    await seedScan(cohort.submissionIds[0]!,
      scanResult([scannedFile('docs/palette.md', 'colour choices')]))

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const [score] = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
    expect(score?.rationale).toMatch(/searched for/)
    expect(score?.rationale).toMatch(/retry|backoff|error/)
  })

  it('records INSUFFICIENT_EVIDENCE when the MODEL says it cannot judge', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([insufficientTurn()])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const [score] = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
    expect(score?.raw_score).toBeNull()
    expect(score?.non_score).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('records SCORING_FAILED after the retries are exhausted, never 0 (acceptance 3)', async () => {
    const cohort = await seedCohort({ count: 1 })
    // Malformed every time: the gateway retries, then gives up.
    provider.setScript([
      { text: 'not json at all' }, { text: '{"score": 9}' }, { text: 'still not json' },
      { text: 'nor this' }, { text: 'nor this' }, { text: 'nor this' },
    ])

    const summary = await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    expect(summary.failed).toBe(1)
    const [score] = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
    expect(score?.raw_score).toBeNull()
    expect(score?.non_score).toBe('SCORING_FAILED')
  })

  it('the database REFUSES a row with both a score and a non-score', async () => {
    expect(await violatedConstraint(
      `INSERT INTO criterion_score
         (run_index_id, submission_id, criterion_id, dimension, rubric_id, rubric_version,
          rubric_hash, raw_score, non_score)
       VALUES ($1, 1, 1, 'RUNS', 1, 1, repeat('a',64), 0, 'SCORING_FAILED')`,
      [runIndexId],
    )).toBe('chk_score_xor_nonscore')
  })

  it('the database REFUSES a row with neither', async () => {
    expect(await violatedConstraint(
      `INSERT INTO criterion_score
         (run_index_id, submission_id, criterion_id, dimension, rubric_id, rubric_version,
          rubric_hash, raw_score, non_score)
       VALUES ($1, 1, 1, 'RUNS', 1, 1, repeat('a',64), NULL, NULL)`,
      [runIndexId],
    )).toBe('chk_score_xor_nonscore')
  })
})

describe('principles and standards (E06-S03)', () => {
  beforeEach(async () => {
    await query(`UPDATE arch_principle SET active = TRUE WHERE code = 'REL_ERRORS'`)
    await query(`UPDATE it_standard SET active = TRUE WHERE code = 'STD_README'`)
  })

  it('assesses only the principles the committee ADOPTED (acceptance 4, OD-2)', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3), principleTurn(3), standardTurn('COMPLIANT'), originalityTurn(3)])

    const summary = await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    // Nine principles are seeded; one was adopted.
    expect(summary.principlesAssessed).toBe(1)
    expect(summary.standardsAssessed).toBe(1)
  })

  it('keeps the 0–4 maturity model for principles (acceptance 2)', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3), principleTurn(2), standardTurn('PARTIAL'), originalityTurn(3)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const [principle] = await selectPrincipleAssessments(runIndexId, cohort.submissionIds[0]!)
    expect(principle?.maturity).toBe(2)
    expect(principle?.code).toBe('REL_ERRORS')
  })

  it('keeps compliant/partial/non-compliant for standards (acceptance 2)', async () => {
    // The README standard needs a README to point at — otherwise the honest outcome is
    // INSUFFICIENT_EVIDENCE, which is a different test.
    const cohort = await seedCohort({
      count: 1,
      files: [RESILIENCE_SOURCE, scannedFile('README.md',
        '# Orders service\n\nRun it with `npm start`. This README describes the project.', 'markdown')],
    })
    provider.setScript([scoreTurn(3), principleTurn(2), standardTurn('NON_COMPLIANT'), originalityTurn(3)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const [standard] = await selectStandardAssessments(runIndexId, cohort.submissionIds[0]!)
    expect(standard?.compliance).toBe('NON_COMPLIANT')
  })

  it('produces evidence in the SAME shape as a criterion score (acceptance 3)', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3), principleTurn(3), standardTurn('COMPLIANT'), originalityTurn(3)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const [principle] = await selectPrincipleAssessments(runIndexId, cohort.submissionIds[0]!)
    const [criterion] = await selectScoresFor(runIndexId, cohort.submissionIds[0]!)
    expect(Object.keys(principle?.evidence[0] ?? {}).sort())
      .toEqual(Object.keys(criterion?.evidence[0] ?? {}).sort())
  })

  it('consumes the code-bearing context, not a tech-stack list (acceptance 1)', async () => {
    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3), principleTurn(3), standardTurn('COMPLIANT'), originalityTurn(3)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    // The principles call is the second request; it must carry real source.
    expect(JSON.stringify(provider.requests[1])).toContain('withRetry')
  })

  it('assesses nothing when the committee has adopted nothing', async () => {
    await query('UPDATE arch_principle SET active = FALSE')
    await query('UPDATE it_standard SET active = FALSE')

    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3), originalityTurn(3)])

    const summary = await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    expect(summary.principlesAssessed).toBe(0)
    expect(summary.standardsAssessed).toBe(0)
  })

  it('ships the nine pillars INACTIVE, so adopting them is a deliberate act', async () => {
    await resetDatabase()
    const rows = await query<{ active: boolean }>('SELECT active FROM arch_principle')
    expect(rows.rows).not.toHaveLength(0)
    expect(rows.rows.every((r) => r.active === false)).toBe(true)
  })
})

describe('the advisory originality signal (E06-S05)', () => {
  it('records the measurements alongside the judgement (acceptance 1)', async () => {
    const cohort = await seedCohort({ count: 1 })
    await query('DELETE FROM scan WHERE submission_id = $1', [cohort.submissionIds[0]!])
    await seedScan(cohort.submissionIds[0]!, scanResult([
      RESILIENCE_SOURCE,
      scannedFile('vite.config.ts', 'import { defineConfig } from "vite"'),
      scannedFile('src/vite-env.d.ts', '/// <reference types="vite/client" />'),
    ]))

    provider.setScript([scoreTurn(3), originalityTurn(2)])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const row = await selectOriginality(runIndexId, cohort.submissionIds[0]!)
    expect(row?.level).toBe(2)
    expect(row?.templates.map((t) => t.id)).toContain('vite-starter')
    expect(Number(row?.boilerplate_share_pct)).toBeGreaterThan(0)
    expect(row?.substantive_lines).toBeGreaterThan(0)
  })

  it('OMITS the dimension when the flag is off, rather than scoring it zero (acceptance 2)', async () => {
    await inScope(() => setFlag('feature.scoring.originality', false, ACTOR))
    invalidateConfig()

    const cohort = await seedCohort({ count: 1 })
    provider.setScript([scoreTurn(3)])

    const summary = await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    expect(summary.originalityAssessed).toBe(false)
    expect(await selectOriginality(runIndexId, cohort.submissionIds[0]!)).toBeNull()
  })

  it('needs no model call when the repository is nothing but scaffold', async () => {
    const cohort = await seedCohort({ count: 1 })
    await query('DELETE FROM scan WHERE submission_id = $1', [cohort.submissionIds[0]!])
    await seedScan(cohort.submissionIds[0]!, scanResult([
      scannedFile('package.json', '{"name":"app"}'),
      scannedFile('src/reportWebVitals.ts', 'reportWebVitals'),
    ]))

    // Only the criterion call is scripted: originality must not make one.
    provider.setScript([insufficientTurn()])

    await inScope(async () => scoreSubmission({
      runIndexId, submissionId: cohort.submissionIds[0]!,
      rubric: await loadRubric(cohort.rubricId),
    }))

    const row = await selectOriginality(runIndexId, cohort.submissionIds[0]!)
    expect(row?.level).toBe(0)
    expect(row?.model).toBeNull()
  })
})
