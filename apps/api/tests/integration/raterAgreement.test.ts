/**
 * The denominator the calibration figure is read against (E33).
 *
 * Crucible measured how much the machine agreed with a human consensus and never measured how
 * much the humans agreed with each other — so a ρ of 0.61 looked the same whether the people
 * behind that consensus were near-identical or barely related. This tests that the report now
 * carries the second number, and carries it ON the first rather than beside it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import {
  addEntry, createGoldenSet, entriesFor, recordRanking, seal,
} from '../../src/modules/calibration/services/goldenSetService.js'
import { generateReport } from '../../src/modules/calibration/services/calibrationReport.js'
import { recordCriteria } from '../../src/modules/calibration/services/gateService.js'
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
let runIndexId: number

const FALLBACK = 'Fall back to fully human judging; the system gathers evidence only.'
const BANDS = ['STRONG', 'STRONG', 'MIDDLING', 'MIDDLING', 'WEAK', 'WEAK', 'WEAK', 'MIDDLING']
const EDGE: Array<string | null> = [
  null, null, 'VERY_LARGE', null, 'SCAFFOLD_ONLY', 'WRONG_PROBLEM', 'FAILS_TO_BUILD', null,
]

async function seedEntries(): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < 8; i++) {
    const entry = await addEntry({
      goldenSetId, label: `entry-${i}`, repoUrl: `https://github.com/golden/repo-${i}`,
      expectedBand: BANDS[i] ?? 'MIDDLING', edgeCase: EDGE[i] ?? null, notes: '', actor: ACTOR,
    })
    ids.push(entry.entry_id)
  }
  return ids
}

const rankAs = (ranker: string, order: readonly number[]) =>
  recordRanking({
    goldenSetId, ranker, actor: ACTOR,
    positions: order.map((entryId, index) => ({ entryId, position: index + 1 })),
  })

/** Seal the set, record criteria, and report — with whatever rankings the test put in. */
async function reportWith(rankings: (ids: number[]) => Promise<unknown>) {
  const ids = await seedEntries()
  await rankings(ids)

  const entries = await entriesFor(goldenSetId)
  for (const [i, submissionId] of cohort.submissionIds.entries()) {
    await linkSubmission(entries[i]!.entry_id, submissionId)
  }
  await seal(goldenSetId, ACTOR)
  await recordCriteria({
    goldenSetId, minRankCorrelation: 0.7, maxMaterialDisagreements: 1,
    materialRankGap: 3, maxRunVariance: 10, fallbackPlan: FALLBACK, notes: '', actor: ACTOR,
  })
  return generateReport({ goldenSetId, runIndexId, actor: ACTOR })
}

const agreementOf = (report: { detail: unknown }) =>
  (report.detail as { interRater: { strength: string; lowest: number | null; note: string
    pairs: Array<{ a: string; b: string; rho: number | null }> } }).interRater

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  provider.setResponder((req) =>
    JSON.stringify(req).includes('ADVISORY') ? originalityTurn(3) : scoreTurn(3))

  const set = await createGoldenSet({ name: 'Golden 2026', description: '', actor: ACTOR })
  goldenSetId = set.golden_set_id

  cohort = await seedCohort({ count: 4 })
  const outcome = await inScope(() => startRun({
    cohortKey: 'golden-cohort', runIndex: 1,
    submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  runIndexId = outcome.run.run_index_id
  await computeRanking(runIndexId, ACTOR)
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('the report carries how much the rankers agreed', () => {
  it('names every pair, so one outlying ranker is visible rather than averaged away', async () => {
    const report = await reportWith(async (ids) => {
      await rankAs('alice', ids)
      await rankAs('bob', ids)
      await rankAs('carol', [...ids].reverse())
    })

    const raters = agreementOf(report)
    expect(raters.pairs.map((p) => `${p.a}|${p.b}`).sort())
      .toEqual(['alice|bob', 'alice|carol', 'bob|carol'])
    // Alice and Bob agree perfectly; the consensus is still only as good as Carol's pair.
    expect(raters.strength).toBe('WEAK')
  })

  it('is STRONG when the rankers share an ordering', async () => {
    const report = await reportWith(async (ids) => {
      await rankAs('alice', ids)
      await rankAs('bob', ids)
    })
    expect(agreementOf(report).strength).toBe('STRONG')
    expect(agreementOf(report).lowest).toBe(1)
  })
})

describe('the caveat travels with the number, not beside it', () => {
  it('appends the ranker agreement to the correlation note when it is WEAK', async () => {
    const report = await reportWith(async (ids) => {
      await rankAs('alice', ids)
      await rankAs('bob', [...ids].reverse())
    })

    // The reader who sees the coefficient is the reader who has to know what it was measured
    // against, so it goes in the note that is stored with it.
    expect(report.correlation_note).toMatch(/RANKER AGREEMENT/)
    expect(report.correlation_note).toMatch(/no stable human judgement/)
  })

  it('adds NO caveat when agreement is strong, so the note keeps meaning something', async () => {
    const report = await reportWith(async (ids) => {
      await rankAs('alice', ids)
      await rankAs('bob', ids)
    })
    expect(report.correlation_note ?? '').not.toMatch(/RANKER AGREEMENT/)
  })

  it('records the agreement in the audit trail beside the coefficient', async () => {
    await reportWith(async (ids) => {
      await rankAs('alice', ids)
      await rankAs('bob', [...ids].reverse())
    })

    const audit = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_event WHERE action = 'calibration.report_generated'`)
    expect(audit.rows[0]?.payload).toMatchObject({ raterAgreement: 'WEAK' })
  })
})

describe('what it does NOT do', () => {
  it('leaves the gate criteria alone — a threshold is not moved once the number is known', async () => {
    const report = await reportWith(async (ids) => {
      await rankAs('alice', ids)
      await rankAs('bob', [...ids].reverse())
    })

    // Weak agreement qualifies the verdict; it does not silently become a second gate. The
    // criteria recorded before the report are still the only thresholds (E11-S03).
    expect(report.criteria_id).toBeGreaterThan(0)
    expect(report.rank_correlation).not.toBeNull()
  })
})
