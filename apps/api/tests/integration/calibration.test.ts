/**
 * The golden set, the calibration report and the gate (E11).
 *
 * This epic exists to establish whether the system is fit to eliminate teams, so the tests
 * concentrate on the two things that would make that establishment worthless: a hand ranking
 * edited after seeing the machine's answer, and a threshold chosen after seeing the number it
 * has to clear. Both are prevented by the schema, and both are tested against it.
 *
 * The third is the one that matters most in practice — that a failed gate actually stops
 * ranking, rather than being a paragraph nobody reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import {
  addEntry, createGoldenSet, entriesFor, rankingsFor, readiness, recordRanking, seal,
} from '../../src/modules/calibration/services/goldenSetService.js'
import { generateReport } from '../../src/modules/calibration/services/calibrationReport.js'
import {
  assertRankingPermitted, assess, decide, recordCriteria,
} from '../../src/modules/calibration/services/gateService.js'
import { currentCriteria } from '../../src/modules/calibration/db/gateDb.js'
import { linkSubmission } from '../../src/modules/calibration/db/calibrationDb.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let goldenSetId: number
let cohort: CohortFixture

const BANDS = ['STRONG', 'STRONG', 'MIDDLING', 'MIDDLING', 'WEAK', 'WEAK', 'WEAK', 'MIDDLING']
const EDGE: Array<string | null> = [
  null, null, 'VERY_LARGE', null, 'SCAFFOLD_ONLY', 'WRONG_PROBLEM', 'FAILS_TO_BUILD', null,
]

const FALLBACK = 'Fall back to fully human judging; the system gathers evidence only.'

/** Eight entries spanning the bands and every required edge case (E11-S01). */
async function seedEntries(count = 8): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const entry = await addEntry({
      goldenSetId,
      label: `entry-${i}`,
      repoUrl: `https://github.com/golden/repo-${i}`,
      expectedBand: BANDS[i] ?? 'MIDDLING',
      edgeCase: EDGE[i] ?? null,
      notes: '',
      actor: ACTOR,
    })
    ids.push(entry.entry_id)
  }
  return ids
}

const rankAll = (ids: readonly number[], ranker: string, order?: readonly number[]) =>
  recordRanking({
    goldenSetId, ranker, actor: ACTOR,
    positions: (order ?? ids).map((entryId, index) => ({ entryId, position: index + 1 })),
  })

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  const set = await createGoldenSet({ name: 'Golden 2026', description: '', actor: ACTOR })
  goldenSetId = set.golden_set_id
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('the golden set (E11-S01)', () => {
  it('REFUSES to seal with fewer than eight repositories', async () => {
    const ids = await seedEntries(4)
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')

    await expect(seal(goldenSetId, ACTOR)).rejects.toThrow(/4 of 8 repositories/)
  })

  it('REFUSES to seal with only one hand ranking (acceptance 3)', async () => {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')

    // One person's ordering cannot be distinguished from that person's preferences.
    await expect(seal(goldenSetId, ACTOR)).rejects.toThrow(/1 of 2 hand rankings/)
  })

  it('REFUSES to seal without every edge case (acceptance 2)', async () => {
    const ids: number[] = []
    for (let i = 0; i < 8; i++) {
      const entry = await addEntry({
        goldenSetId, label: `plain-${i}`, repoUrl: `https://github.com/g/r${i}`,
        expectedBand: BANDS[i] ?? 'MIDDLING', edgeCase: null, notes: '', actor: ACTOR,
      })
      ids.push(entry.entry_id)
    }
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')

    await expect(seal(goldenSetId, ACTOR)).rejects.toThrow(/Missing edge case/)
  })

  it('REFUSES to seal when a ranking is incomplete', async () => {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await recordRanking({
      goldenSetId, ranker: 'bob', actor: ACTOR,
      positions: ids.slice(0, 4).map((entryId, index) => ({ entryId, position: index + 1 })),
    }).catch(() => undefined)

    const state = await readiness(goldenSetId)
    expect(state.canSeal).toBe(false)
  })

  it('refuses a partial ranking at the point it is submitted', async () => {
    const ids = await seedEntries()
    await expect(recordRanking({
      goldenSetId, ranker: 'bob', actor: ACTOR,
      positions: [{ entryId: ids[0]!, position: 1 }],
    })).rejects.toThrow(/must place every one of the 8 entries/)
  })

  it('seals when the set spans the range and two people have ranked it', async () => {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')

    const sealed = await seal(goldenSetId, ACTOR)
    expect(sealed.status).toBe('SEALED')
    expect(sealed.sealed_by).toBe(ACTOR)
  })

  it('PROTECTS independence: a ranker sees only their own while the set is open', async () => {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')

    const asAlice = await rankingsFor(goldenSetId, 'alice')
    expect(asAlice.every((r) => r.ranker === 'alice')).toBe(true)
  })

  it('shows every ranking once sealed, when independence no longer matters', async () => {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')
    await seal(goldenSetId, ACTOR)

    const all = await rankingsFor(goldenSetId, 'alice')
    expect(new Set(all.map((r) => r.ranker))).toEqual(new Set(['alice', 'bob']))
  })
})

describe('a sealed set is fixed (acceptance 3)', () => {
  beforeEach(async () => {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')
    await seal(goldenSetId, ACTOR)
  })

  it('REFUSES a hand ranking added after sealing', async () => {
    const ids = (await entriesFor(goldenSetId)).map((e) => e.entry_id)
    // A ranking submitted after the machine has scored says nothing about the machine.
    await expect(rankAll(ids, 'carol')).rejects.toThrow(/sealed/)
  })

  it('REFUSES a new entry after sealing', async () => {
    await expect(addEntry({
      goldenSetId, label: 'late', repoUrl: 'https://github.com/g/late',
      expectedBand: 'STRONG', edgeCase: null, notes: '', actor: ACTOR,
    })).rejects.toThrow(/sealed/)
  })

  it('the DATABASE refuses an edit even outside the service', async () => {
    await expect(query(
      'UPDATE golden_ranking SET position = 1 WHERE golden_set_id = $1', [goldenSetId],
    )).rejects.toThrow(/SEALED/)
  })

  it('PERMITS recording which submission an entry was scored as', async () => {
    // Sealing is what allows scoring, so the result of scoring must still be recordable.
    const [entry] = await entriesFor(goldenSetId)
    await expect(linkSubmission(entry!.entry_id, 4242)).resolves.toBeUndefined()

    const after = await entriesFor(goldenSetId)
    expect(after[0]?.submission_id).toBe(4242)
  })

  it('still refuses to change an entry’s JUDGEMENT while sealed', async () => {
    // The exception is narrow: only the submission link moves.
    await expect(query(
      `UPDATE golden_entry SET expected_band = 'WEAK' WHERE golden_set_id = $1`, [goldenSetId],
    )).rejects.toThrow(/SEALED/)
  })

  it('refuses to seal twice', async () => {
    await expect(seal(goldenSetId, ACTOR)).rejects.toThrow(/already sealed/)
  })
})

describe('gate criteria come first (E11-S03 acceptance 1)', () => {
  beforeEach(async () => {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')
    await seal(goldenSetId, ACTOR)
  })

  it('REFUSES to produce a report before criteria are recorded', async () => {
    await expect(generateReport({ goldenSetId, runIndexId: 1, actor: ACTOR }))
      .rejects.toThrow(/written down\s+BEFORE the report/)
  })

  it('the DATABASE refuses to edit recorded criteria', async () => {
    await recordCriteria({
      goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1,
      materialRankGap: 3, maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '', actor: ACTOR,
    })

    // A threshold edited once the coefficient is known is a rationalisation, not a threshold.
    await expect(query('UPDATE gate_criteria SET min_rank_correlation = 0.1'))
      .rejects.toThrow(/append-only/)
  })

  it('refuses a fallback plan too short to be a plan', async () => {
    await expect(recordCriteria({
      goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1,
      materialRankGap: 3, maxRunVariance: 10, fallbackPlan: 'human', notes: '', actor: ACTOR,
    })).rejects.toThrow()
  })

  it('audits the criteria with their thresholds', async () => {
    await recordCriteria({
      goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1,
      materialRankGap: 3, maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '', actor: ACTOR,
    })

    const audit = await query<{ payload: { minRankCorrelation: number } }>(
      `SELECT payload FROM audit_event WHERE action = 'calibration.gate_criteria_recorded'`)
    expect(Number(audit.rows[0]?.payload.minRankCorrelation)).toBe(0.7)
  })
})

describe('the report (E11-S02)', () => {
  let runIndexId: number

  beforeEach(async () => {
    // Four scored submissions standing in for golden entries.
    cohort = await seedCohort({ count: 4 })
    provider.setResponder((req) =>
      JSON.stringify(req).includes('ADVISORY') ? originalityTurn(3) : scoreTurn(3))

    const outcome = await inScope(() => startRun({
      cohortKey: 'golden-cohort', runIndex: 1,
      submissionIds: cohort.submissionIds, startedBy: ACTOR,
    }))
    runIndexId = outcome.run.run_index_id
    await computeRanking(runIndexId, ACTOR)

    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')

    const entries = await entriesFor(goldenSetId)
    for (const [i, submissionId] of cohort.submissionIds.entries()) {
      await linkSubmission(entries[i]!.entry_id, submissionId)
    }

    await seal(goldenSetId, ACTOR)
    await recordCriteria({
      goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1,
      materialRankGap: 3, maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '', actor: ACTOR,
    })
  })

  it('REFUSES to run against an unsealed set', async () => {
    const other = await createGoldenSet({ name: 'Open', description: '', actor: ACTOR })
    await expect(generateReport({
      goldenSetId: other.golden_set_id, runIndexId, actor: ACTOR,
    })).rejects.toThrow(/not sealed/)
  })

  it('reports the correlation with its SAMPLE SIZE (acceptance 1)', async () => {
    const report = await generateReport({ goldenSetId, runIndexId, actor: ACTOR })
    expect(report.sample_size).toBe(4)
    expect(report).toHaveProperty('rank_correlation')
  })

  it('records the criteria it was judged against', async () => {
    const report = await generateReport({ goldenSetId, runIndexId, actor: ACTOR })
    const criteria = await currentCriteria(goldenSetId)
    expect(report.criteria_id).toBe(criteria?.criteria_id)
  })

  it('lists every disagreement with the entry LABEL, not just an id', async () => {
    const report = await generateReport({ goldenSetId, runIndexId, actor: ACTOR })
    const detail = report.detail as { disagreements: Array<{ label: string }> }
    expect(detail.disagreements.length).toBeGreaterThan(0)
    expect(detail.disagreements[0]?.label).toMatch(/entry-/)
  })

  it('reports how each individual ranker compares, so an outlier is visible', async () => {
    const report = await generateReport({ goldenSetId, runIndexId, actor: ACTOR })
    const detail = report.detail as { perRanker: Array<{ ranker: string }> }
    expect(detail.perRanker.map((p) => p.ranker).sort()).toEqual(['alice', 'bob'])
  })

  it('REFUSES when none of the entries were scored', async () => {
    await query('UPDATE golden_entry SET submission_id = NULL WHERE golden_set_id = $1',
      [goldenSetId])
    await expect(generateReport({ goldenSetId, runIndexId, actor: ACTOR }))
      .rejects.toThrow(/Score the set before comparing/)
  })

  it('audits its own generation', async () => {
    await generateReport({ goldenSetId, runIndexId, actor: ACTOR })
    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'calibration.report_generated'`)
    expect(audit.rows).toHaveLength(1)
  })
})

describe('the gate stops ranking (E11-S03 acceptance 3)', () => {
  beforeEach(async () => {
    await inScope(() => setFlag('feature.calibration.bypass_gate', false, ACTOR))
    invalidateConfig()
  })

  it('REFUSES to rank when no decision has been recorded', async () => {
    // "No decision" is not "go". An uncalibrated system must not be usable by default.
    await expect(assertRankingPermitted())
      .rejects.toThrow(/No go\/no-go decision has been recorded/)
  })

  it('says evidence gathering REMAINS available', async () => {
    await expect(assertRankingPermitted()).rejects.toThrow(/Scanning, probing and scoring remain/)
  })

  it('REFUSES to rank after a NO_GO, quoting the fallback plan', async () => {
    const reportId = await seedReport()
    await decide({
      reportId, decision: 'NO_GO', actor: 'chair@test.local',
      rationale: 'Correlation is below the recorded threshold and two placements are wrong.',
    })

    await expect(assertRankingPermitted()).rejects.toThrow(/gate was failed/)
    await expect(assertRankingPermitted()).rejects.toThrow(/fully human judging/)
  })

  it('PERMITS ranking after a GO', async () => {
    const reportId = await seedReport()
    await decide({
      reportId, decision: 'GO', actor: 'chair@test.local',
      rationale: 'Every recorded criterion is met and the disagreements are all one place.',
    })

    await expect(assertRankingPermitted()).resolves.toBeUndefined()
  })

  it('actually blocks computeRanking, not merely the helper', async () => {
    cohort = await seedCohort({ count: 2 })
    provider.setResponder((req) =>
      JSON.stringify(req).includes('ADVISORY') ? originalityTurn(3) : scoreTurn(3))
    const outcome = await inScope(() => startRun({
      cohortKey: 'blocked', runIndex: 1,
      submissionIds: cohort.submissionIds, startedBy: ACTOR,
    }))

    await expect(computeRanking(outcome.run.run_index_id, ACTOR))
      .rejects.toThrow(/No go\/no-go decision/)
  })

  it('the bypass flag permits ranking, and is OFF in this suite by choice', async () => {
    await inScope(() => setFlag('feature.calibration.bypass_gate', true, ACTOR))
    invalidateConfig()
    await expect(assertRankingPermitted()).resolves.toBeUndefined()
  })

  it('the DATABASE refuses to edit a recorded decision', async () => {
    const reportId = await seedReport()
    await decide({
      reportId, decision: 'NO_GO', actor: ACTOR,
      rationale: 'The correlation was below the recorded threshold.',
    })
    await expect(query(`UPDATE gate_decision SET decision = 'GO'`))
      .rejects.toThrow(/append-only/)
  })

  async function seedReport(): Promise<number> {
    const ids = await seedEntries()
    await rankAll(ids, 'alice')
    await rankAll(ids, 'bob')
    await seal(goldenSetId, ACTOR)
    const criteria = await recordCriteria({
      goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1,
      materialRankGap: 3, maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '', actor: ACTOR,
    })

    const row = await query<{ report_id: number }>(
      `INSERT INTO calibration_report
         (golden_set_id, criteria_id, run_index_id, rank_correlation, sample_size,
          material_disagreements, generated_by)
       VALUES ($1,$2,1,0.5,8,3,'test') RETURNING report_id`,
      [goldenSetId, criteria.criteria_id])
    return row.rows[0]!.report_id
  }
})

describe('assessing a report against its criteria', () => {
  const criteria = {
    criteria_id: 1, golden_set_id: 1, min_rank_correlation: 0.7,
    max_material_disagreements: 1, material_rank_gap: 3, max_run_variance: 10,
    fallback_plan: FALLBACK, notes: '', recorded_by: 'x', recorded_at: new Date(),
  }
  const report = (over: Record<string, unknown> = {}) => ({
    report_id: 1, golden_set_id: 1, criteria_id: 1, run_index_id: 1,
    second_run_index_id: null, rank_correlation: 0.85, correlation_note: null,
    sample_size: 8, material_disagreements: 0, max_run_variance: 4,
    detail: {}, generated_by: 'x', generated_at: new Date(), ...over,
  })

  it('suggests GO when every criterion is met', () => {
    expect(assess(report(), criteria).suggested).toBe('GO')
  })

  it('suggests NO_GO on a correlation below the threshold', () => {
    const result = assess(report({ rank_correlation: 0.4 }), criteria)
    expect(result.suggested).toBe('NO_GO')
    expect(result.reasons[0]).toMatch(/below the 0.7 required/)
  })

  it('treats an UNCOMPUTABLE correlation as a failure, not a pass', () => {
    const result = assess(
      report({ rank_correlation: null, correlation_note: 'too few items' }), criteria)
    expect(result.suggested).toBe('NO_GO')
    expect(result.reasons[0]).toMatch(/no evidence the machine orders work as a person does/)
  })

  it('suggests NO_GO on too many material disagreements', () => {
    expect(assess(report({ material_disagreements: 5 }), criteria).suggested).toBe('NO_GO')
  })

  it('suggests NO_GO on variance above the threshold', () => {
    expect(assess(report({ max_run_variance: 40 }), criteria).suggested).toBe('NO_GO')
  })

  it('reports UNMEASURED variance as a gap without failing on it', () => {
    const result = assess(report({ max_run_variance: null }), criteria)
    // The second run may simply not have happened yet; that is a gap to fill, not a failure.
    expect(result.suggested).toBe('GO')
    expect(result.reasons.some((r) => /not measured/.test(r))).toBe(true)
  })

  it('never calls its own output a decision', () => {
    // The system evaluates its thresholds and stops. A person decides.
    expect(assess(report(), criteria)).toHaveProperty('suggested')
    expect(assess(report(), criteria)).not.toHaveProperty('decision')
  })
})
