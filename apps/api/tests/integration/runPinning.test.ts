/**
 * Runs that mean something (E14, P4.4).
 *
 * `run.pinned_config` has existed since migration 004 with a comment promising that "a config
 * change must not affect an in-flight run". It held four operational keys, no feature flags,
 * nothing that decided an outcome — and it was read by nothing at all. The promise was a
 * comment.
 *
 * These prove the three things that make it a mechanism: the pin covers what decides an
 * outcome, it is HELD TO while the run is in flight, and two runs that were not executed alike
 * say so rather than letting a variance flag be read as model instability.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import {
  captureRunPin, getNumber, invalidateConfig, isEnabled, setConfig, setFlag,
} from '../../src/modules/platform/services/configService.js'
import { withRunPin, withoutRunPin } from '../../src/lib/runScope.js'
import { ACTOR, inScope } from '../support/scoringFixtures.js'
import { query } from '../../src/db/pool.js'

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
})

afterEach(() => invalidateConfig())

describe('what a pin covers (E14-S01)', () => {
  it('carries every setting declared as deciding an outcome', async () => {
    const pin = await captureRunPin()

    // Derived from the declaration, so it cannot stop covering settings added later.
    const declared = await query<{ key: string }>(
      'SELECT key FROM app_config WHERE affects_outcome ORDER BY key')
    expect(Object.keys(pin.config).sort()).toEqual(declared.rows.map((r) => r.key))
    expect(declared.rows.length).toBeGreaterThan(20)
  })

  it('carries the settings that actually shape a score', async () => {
    const pin = await captureRunPin()
    for (const key of [
      'scoring.cut_line', 'scoring.context_budget_bytes', 'scoring.variance_delta_threshold',
      'scoring.min_cohort_size', 'llm.default_model', 'probes.timeout_ms',
    ]) {
      expect(pin.config, key).toHaveProperty(key)
    }
  })

  it('carries EVERY feature flag, because a flag change is always an outcome change', async () => {
    const pin = await captureRunPin()
    const flags = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM feature_flag')
    expect(Object.keys(pin.flags)).toHaveLength(flags.rows[0]!.n)
    expect(pin.flags).toHaveProperty('feature.discovery.enabled')
  })

  it('leaves operational knobs OUT, so an operator can still act on a run in flight', async () => {
    // P4.4 and E10-S03 both hold: a ceiling decides whether the run finishes, not what anything
    // scores, and an operator raising it to unpause a batch must see it take effect.
    const pin = await captureRunPin()
    for (const key of [
      'llm.concurrency', 'llm.cost_ceiling_usd_per_run', 'batch.cost_ceiling_usd',
      'batch.scan_concurrency',
    ]) {
      expect(pin.config, key).not.toHaveProperty(key)
    }
  })
})

describe('the pin is HELD TO (E14-S02)', () => {
  it('resolves an outcome setting from the pin, not from the database', async () => {
    // Read rather than assumed: the declared default is the migration's business, and hard-coding
    // it here would make this test fail for a reason that has nothing to do with pinning.
    const before = await getNumber('scoring.cut_line')
    const pin = await captureRunPin()
    await inScope(() => setConfig('scoring.cut_line', before + 93, ACTOR))
    invalidateConfig()

    // The change is live for anyone outside the run...
    expect(await getNumber('scoring.cut_line')).toBe(before + 93)
    // ...and invisible to the run in flight.
    await withRunPin(pin, async () => {
      expect(await getNumber('scoring.cut_line')).toBe(before)
    })
  })

  it('holds a FLAG too — discovery cannot be switched on mid-cohort', async () => {
    const pin = await captureRunPin()
    expect(pin.flags['feature.discovery.enabled']).toBe(false)

    await inScope(() => setFlag('feature.discovery.enabled', true, ACTOR))
    invalidateConfig()

    expect(await isEnabled('feature.discovery.enabled')).toBe(true)
    await withRunPin(pin, async () => {
      // Half a cohort scored with discovery's extra context and half without would be scored on
      // unequal evidence, silently.
      expect(await isEnabled('feature.discovery.enabled')).toBe(false)
    })
  })

  it('lets OPERATIONAL settings through, so raising a ceiling mid-run still works', async () => {
    const pin = await captureRunPin()
    await inScope(() => setConfig('llm.cost_ceiling_usd_per_run', 500, ACTOR))
    invalidateConfig()

    await withRunPin(pin, async () => {
      expect(await getNumber('llm.cost_ceiling_usd_per_run')).toBe(500)
    })
  })

  it('REFUSES an outcome setting the pin does not carry, rather than reading it live', async () => {
    // The rule that stops this regressing: a silent fall-through would reintroduce the bug for
    // exactly the settings nobody remembered to include.
    const pin = await captureRunPin()
    delete pin.config['scoring.cut_line']

    await withRunPin(pin, async () => {
      await expect(getNumber('scoring.cut_line')).rejects.toThrow(/not in this run's pin/i)
    })
  })

  it('REFUSES a flag the pin does not carry', async () => {
    const pin = await captureRunPin()
    delete pin.flags['feature.discovery.enabled']

    await withRunPin(pin, async () => {
      await expect(isEnabled('feature.discovery.enabled')).rejects.toThrow(/not in this run's pin/i)
    })
  })

  it('can be stepped out of explicitly for a read that must be live', async () => {
    const before = await getNumber('scoring.cut_line')
    const pin = await captureRunPin()
    await inScope(() => setConfig('scoring.cut_line', before + 36, ACTOR))
    invalidateConfig()

    await withRunPin(pin, async () => {
      expect(await getNumber('scoring.cut_line')).toBe(before)
      await withoutRunPin(async () => {
        expect(await getNumber('scoring.cut_line')).toBe(before + 36)
      })
    })
  })

  it('survives across await boundaries, so concurrent work stays inside its own run', async () => {
    // AsyncLocalStorage rather than a threaded parameter: a threaded pin gets dropped at the
    // first refactor, silently, in the services where silence matters most.
    const before = await getNumber('scoring.cut_line')
    const pin = await captureRunPin()
    await inScope(() => setConfig('scoring.cut_line', before + 71, ACTOR))
    invalidateConfig()

    await withRunPin(pin, async () => {
      await Promise.all([
        (async () => { expect(await getNumber('scoring.cut_line')).toBe(before) })(),
        (async () => {
          await new Promise((r) => setTimeout(r, 5))
          expect(await getNumber('scoring.cut_line')).toBe(before)
        })(),
      ])
    })
  })
})

describe('what a run records', () => {
  it('stores the pin on the scoring run it opened', async () => {
    const { insertScoreRun } = await import('../../src/modules/scoring/db/scoringDb.js')
    const pin = await captureRunPin()
    const run = await insertScoreRun({
      runIndex: 1, cohortKey: `pin-${Date.now()}`, rubricVersions: {},
      model: 'fake', ledgerRunId: null, startedBy: ACTOR, pinnedConfig: pin,
    })

    const stored = await query<{ pinned_config: { config: Record<string, unknown> } }>(
      'SELECT pinned_config FROM score_run WHERE run_index_id = $1', [run.run_index_id])
    expect(Object.keys(stored.rows[0]!.pinned_config.config).length).toBeGreaterThan(20)
  })
})
