/**
 * A GO vouches for the settings it was measured under, and no others (E25).
 *
 * The gate establishes that this system's ranking tracks a committee's — under a particular cut
 * line, a particular normalisation floor, particular weights. Change one of those and the verdict
 * is about a system that no longer exists.
 *
 * This was already computed and already shown: `gateStatus` compared the recorded pin against the
 * settings in force and the banner said plainly that the verdict "does not vouch for a run under
 * the current ones". Ranking proceeded anyway. A recorded fact nobody acts on is the defect this
 * codebase has found four times now, and this is the highest-stakes instance: it is the control
 * P0 puts in front of ranking.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { assertRankingPermitted } from '../../src/modules/calibration/services/gateService.js'
import { captureRunPin } from '../../src/modules/platform/services/configService.js'
import { query } from '../../src/db/pool.js'
import { ACTOR, inScope } from '../support/scoringFixtures.js'

/**
 * A recorded gate decision, pinned to whatever settings are in force right now.
 *
 * `pinned = false` writes an EMPTY pin rather than a null one, because that is the shape a
 * decision taken before configuration recording actually has — the column is NOT NULL and
 * defaults to `{}`.
 */
async function seedGate(decision: 'GO' | 'NO_GO', pinned = true): Promise<void> {
  const set = await query<{ golden_set_id: number }>(
    `INSERT INTO golden_set (name, status, sealed_at, sealed_by, created_by)
     VALUES ('G', 'SEALED', now(), 'x', 'x') RETURNING golden_set_id`)
  const criteria = await query<{ criteria_id: number }>(
    `INSERT INTO gate_criteria
       (golden_set_id, min_rank_correlation, max_material_disagreements, material_rank_gap,
        max_run_variance, fallback_plan, recorded_by)
     VALUES ($1, 0.7, 1, 3, 10, 'Fall back to fully human judging entirely.', 'x')
     RETURNING criteria_id`, [set.rows[0]!.golden_set_id])
  const report = await query<{ report_id: number }>(
    `INSERT INTO calibration_report
       (golden_set_id, criteria_id, run_index_id, rank_correlation, sample_size,
        material_disagreements, generated_by)
     VALUES ($1, $2, 1, 0.9, 12, 0, 'x') RETURNING report_id`,
    [set.rows[0]!.golden_set_id, criteria.rows[0]!.criteria_id])

  await query(
    `INSERT INTO gate_decision (report_id, decision, rationale, decided_by, pinned_config)
     VALUES ($1, $2, 'Recorded for the purposes of this test scenario.', 'chair@test.local', $3)`,
    [report.rows[0]!.report_id, decision,
     pinned ? JSON.stringify(await captureRunPin()) : '{}'])
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  // The bypass is ON by default so development can rank; this file is about what happens when
  // it is off, which is the pre-event configuration.
  await query(
    `UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.calibration.bypass_gate'`)
  invalidateConfig()
})

afterEach(() => invalidateConfig())

describe('a GO under the settings in force', () => {
  it('permits ranking', async () => {
    await seedGate('GO')
    invalidateConfig()
    await expect(assertRankingPermitted()).resolves.toBeUndefined()
  })
})

describe('a GO measured under DIFFERENT settings', () => {
  it('REFUSES ranking, naming what moved', async () => {
    await seedGate('GO')
    await inScope(() => setConfig('scoring.cut_line', 99, ACTOR))
    invalidateConfig()

    await expect(assertRankingPermitted()).rejects.toThrow(/under different settings/)
  })

  it('says how to get back to ranking rather than only that it is refused', async () => {
    await seedGate('GO')
    await inScope(() => setConfig('scoring.cut_line', 99, ACTOR))
    invalidateConfig()

    await expect(assertRankingPermitted())
      .rejects.toThrow(/Put the settings back, or calibrate again/)
  })

  it('permits ranking again once the setting is put back', async () => {
    // The refusal is about the mismatch, not about the act of having changed something.
    const before = await query<{ value: string }>(
      `SELECT value::text AS value FROM app_config WHERE key = 'scoring.cut_line'`)
    await seedGate('GO')

    await inScope(() => setConfig('scoring.cut_line', 99, ACTOR))
    invalidateConfig()
    await expect(assertRankingPermitted()).rejects.toThrow()

    await inScope(() => setConfig('scoring.cut_line', JSON.parse(before.rows[0]!.value), ACTOR))
    invalidateConfig()
    await expect(assertRankingPermitted()).resolves.toBeUndefined()
  })

  it('does NOT refuse over a setting that cannot change an outcome', async () => {
    // Only settings declared `affects_outcome` are compared (E14). Concurrency and cost
    // ceilings move freely on the night; a weight or a cut line does not.
    await seedGate('GO')
    await inScope(() => setConfig('batch.scan_concurrency', 2, ACTOR))
    invalidateConfig()

    await expect(assertRankingPermitted()).resolves.toBeUndefined()
  })
})

describe('a GO whose settings were never recorded', () => {
  it('REFUSES, because "we do not know" is not "it is fine"', async () => {
    // The same rule the readiness report keeps: UNKNOWN does not count as ready.
    await seedGate('GO', false)
    invalidateConfig()

    await expect(assertRankingPermitted()).rejects.toThrow(/cannot be tied to a configuration/)
  })
})

describe('what the gate still refuses for the older reasons', () => {
  it('refuses with no decision at all', async () => {
    await expect(assertRankingPermitted()).rejects.toThrow(/has not been shown fit to rank/)
  })

  it('refuses on a NO_GO, whatever the settings say', async () => {
    await seedGate('NO_GO')
    invalidateConfig()
    await expect(assertRankingPermitted()).rejects.toThrow(/gate was failed/)
  })
})

describe('the bypass', () => {
  it('permits ranking despite drift, because that is what it is for', async () => {
    // Development and the calibration run itself have to rank before any gate exists. The flag
    // is deliberately blunt; what makes it safe is that it is loud and turned off before the
    // real evaluation.
    await seedGate('GO')
    await inScope(() => setConfig('scoring.cut_line', 99, ACTOR))
    await query(
      `UPDATE feature_flag SET enabled = TRUE WHERE key = 'feature.calibration.bypass_gate'`)
    invalidateConfig()

    await expect(assertRankingPermitted()).resolves.toBeUndefined()
  })
})
