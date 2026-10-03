/**
 * Config service (P3.6, P7.5, P11.2) and fallback strategies (P3.5).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resetDatabase } from '../setup/integrationSetup.js'
import {
  getBoolean, getJson, getNumber, getString, invalidateConfig, isEnabled,
  listConfig, listFlags, setConfig, setFlag, snapshotConfig,
} from '../../src/modules/platform/services/configService.js'
import { runFallback } from '../../src/modules/llm/services/fallbackRunner.js'
import { registerTestCallKey } from '../support/testServer.js'
import { query } from '../../src/db/pool.js'

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
})

describe('typed config access (P3.6)', () => {
  it('reads declared values with the right type', async () => {
    expect(await getNumber('llm.concurrency')).toBe(4)
    expect(await getString('llm.default_model')).toBe('claude-sonnet-5')
    expect(await getJson<Record<string, unknown>>('llm.model_pricing')).toHaveProperty('claude-sonnet-5')
  })

  it('rejects reading a key as the wrong type rather than coercing silently', async () => {
    await expect(getNumber('llm.default_model')).rejects.toThrow(/declared as 'string'/)
    await expect(getString('llm.concurrency')).rejects.toThrow(/declared as 'number'/)
  })

  it('treats an undeclared key as a defect, never a default (P7.5)', async () => {
    await expect(getNumber('llm.never_declared')).rejects.toThrow(/is not declared/)
  })

  it('reads a boolean key', async () => {
    await query(
      `INSERT INTO app_config (key, value, value_type, description, module)
       VALUES ('platform.test_flagish', 'true'::jsonb, 'boolean', 'test', 'platform')
       ON CONFLICT (key) DO NOTHING`)
    expect(await getBoolean('platform.test_flagish')).toBe(true)
  })
})

describe('cache invalidation (P11.2)', () => {
  it('a write takes effect immediately, not after the TTL', async () => {
    expect(await getNumber('llm.concurrency')).toBe(4)
    await setConfig('llm.concurrency', 9, 'admin@test.local')
    // No waiting: an operator raising a limit mid-run needs it now.
    expect(await getNumber('llm.concurrency')).toBe(9)
  })

  it('records who changed it and keeps the prior value (P7.1)', async () => {
    await setConfig('llm.concurrency', 7, 'operator@test.local')
    const history = await query<{ old_value: string; new_value: string; changed_by: string }>(
      `SELECT old_value::text, new_value::text, changed_by FROM app_config_history
        WHERE key = 'llm.concurrency' AND old_value IS NOT NULL ORDER BY id DESC LIMIT 1`)
    expect(history.rows[0]).toMatchObject({ new_value: '7', changed_by: 'operator@test.local' })
  })

  it('refuses a key that does not exist', async () => {
    await expect(setConfig('llm.invented', 1, 'a')).rejects.toThrow(/does not exist/)
  })
})

describe('run config pinning (P4.4)', () => {
  it('snapshots values so a mid-run config change cannot alter an in-flight run', async () => {
    const pinned = await snapshotConfig(['llm.concurrency', 'llm.default_model'])
    expect(pinned).toEqual({ 'llm.concurrency': 4, 'llm.default_model': 'claude-sonnet-5' })

    await setConfig('llm.concurrency', 99, 'admin')
    // The snapshot is a value, not a live view.
    expect(pinned['llm.concurrency']).toBe(4)
  })
})

describe('listing and flags (P12.3)', () => {
  it('lists all config, and filters by module', async () => {
    const all = await listConfig()
    const llmOnly = await listConfig('llm')
    expect(all.length).toBeGreaterThan(llmOnly.length)
    expect(llmOnly.every((r) => r.module === 'llm')).toBe(true)
  })

  it('reads a declared flag', async () => {
    expect(await isEnabled('feature.scoring.double_run')).toBe(true)
    expect(await isEnabled('feature.probes.network_egress')).toBe(false)
  })

  it('treats an unknown flag as disabled, never assumed on', async () => {
    expect(await isEnabled('feature.made.up')).toBe(false)
  })

  it('toggles a flag with immediate effect', async () => {
    await setFlag('feature.probes.network_egress', true, 'admin@test.local')
    expect(await isEnabled('feature.probes.network_egress')).toBe(true)
  })

  it('refuses an undeclared flag', async () => {
    await expect(setFlag('feature.not.declared', true, 'a')).rejects.toThrow(/does not exist/)
  })

  it('lists flags', async () => {
    expect((await listFlags()).length).toBeGreaterThan(0)
  })
})

describe('fallback strategies (P3.5)', () => {
  const schema = z.object({ label: z.string(), n: z.number() })

  async function rule(callKey: string, strategy: string, config: unknown) {
    await registerTestCallKey({ callKey, userPrompt: 'Go.', hasFallback: true })
    await query(
      `INSERT INTO llm_fallback_rule (call_key, strategy, config) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (call_key) DO UPDATE SET strategy = EXCLUDED.strategy, config = EXCLUDED.config`,
      [callKey, strategy, JSON.stringify(config)])
  }

  it('TEMPLATE_RETURN returns the configured value', async () => {
    await rule('test.fb_template', 'TEMPLATE_RETURN', { value: { label: 'x', n: 1 } })
    expect(await runFallback('test.fb_template', { callKey: 'test.fb_template', schema }))
      .toEqual({ label: 'x', n: 1 })
  })

  it('FIELD_FORMULA builds an object from literals and variable references', async () => {
    await rule('test.fb_formula', 'FIELD_FORMULA', { fields: { label: '{{team}}', n: 2 } })
    const out = await runFallback('test.fb_formula', {
      callKey: 'test.fb_formula', schema, variables: { team: 'Alpha' },
    })
    expect(out).toEqual({ label: 'Alpha', n: 2 })
  })

  it('PASSTHROUGH echoes the variables', async () => {
    await rule('test.fb_pass', 'PASSTHROUGH', {})
    const out = await runFallback('test.fb_pass', {
      callKey: 'test.fb_pass', schema, variables: { label: 'echo', n: 3 },
    })
    expect(out).toEqual({ label: 'echo', n: 3 })
  })

  it('returns null when the registry declares a fallback but no rule is configured', async () => {
    await registerTestCallKey({ callKey: 'test.fb_missing', userPrompt: 'Go.', hasFallback: true })
    expect(await runFallback('test.fb_missing', { callKey: 'test.fb_missing', schema })).toBeNull()
  })

  it('refuses output that fails the caller schema rather than returning it (P4.1)', async () => {
    await rule('test.fb_bad', 'TEMPLATE_RETURN', { value: { wrong: true } })
    expect(await runFallback('test.fb_bad', { callKey: 'test.fb_bad', schema })).toBeNull()
  })

  it('refuses a strategy the service does not recognise (P8.5)', async () => {
    await registerTestCallKey({ callKey: 'test.fb_unknown', userPrompt: 'Go.', hasFallback: true })
    // Temporarily drop the CHECK to simulate a value written by a different version of the
    // schema — the case where the service must not trust the layer below it.
    await query('ALTER TABLE llm_fallback_rule DROP CONSTRAINT IF EXISTS llm_fallback_rule_strategy_check')
    try {
      await query(
        `INSERT INTO llm_fallback_rule (call_key, strategy, config)
         VALUES ('test.fb_unknown','WISHFUL','{}'::jsonb)`)
      expect(await runFallback('test.fb_unknown', { callKey: 'test.fb_unknown', schema })).toBeNull()
    } finally {
      // The offending row must go before the constraint can be restored, or every later test
      // in this file inherits a table with no CHECK on it.
      await query(`DELETE FROM llm_fallback_rule WHERE strategy = 'WISHFUL'`)
      await query(`ALTER TABLE llm_fallback_rule ADD CONSTRAINT llm_fallback_rule_strategy_check
        CHECK (strategy IN ('RULE_BASED','PASSTHROUGH','TEMPLATE_RETURN','SHA256_DEDUP','FIELD_FORMULA'))`)
    }
  })
})
