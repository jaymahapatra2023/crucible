/**
 * What a configuration value is allowed to be (E37).
 *
 * `app_config.value_type` was declared on every row since E01 and nothing ever checked a write
 * against it, so a key declared `number` could be set to a string. Worse, a value of the right
 * type in the wrong SHAPE was stored silently — and `scans.event_window` is the case that
 * matters, because the scanner then reads it as "no window" and counts every commit as
 * in-window, on a setting flagged `affects_outcome`.
 *
 * These tests are mostly refusals, and each one checks the refusal SAYS what is wrong. An
 * operator who has just been told "invalid" has learned nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import {
  getJson, invalidateConfig, setConfig,
} from '../../src/modules/platform/services/configService.js'
import { validateConfigValue } from '../../src/modules/platform/services/configSchemas.js'
import { readinessReport } from '../../src/modules/platform/services/readinessReport.js'
import { query } from '../../src/db/pool.js'

const ACTOR = 'admin@test.local'

const WINDOW = { startsAt: '2026-10-03T12:00:00-04:00', endsAt: '2026-10-04T12:00:00-04:00' }

const set = (key: string, value: unknown) => setConfig(key, value, ACTOR)

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
})

describe('the declared type is finally enforced', () => {
  it('REFUSES a string for a key declared number, naming both', async () => {
    await expect(set('submissions.max_artifact_urls', 'five'))
      .rejects.toThrow(/declared number, but the value given is a string/)
  })

  it('REFUSES a number for a key declared string', async () => {
    await expect(set('event.evaluation_date', 20261004))
      .rejects.toThrow(/declared string, but the value given is a number/)
  })

  it('REFUSES a bare string for a key declared json', async () => {
    // The mismatch that made `getJson<T>`'s cast a lie.
    await expect(set('submissions.allowed_hosts', 'github.com'))
      .rejects.toThrow(/declared json, but the value given is a string/)
  })

  it('still accepts a correct value', async () => {
    const row = await set('event.evaluation_date', '2026-10-04')
    expect(row.value).toBe('2026-10-04')
  })
})

describe('the event window, which is the one that was dangerous', () => {
  it('accepts a well-formed window', async () => {
    await set('scans.event_window', WINDOW)
    expect(await getJson('scans.event_window')).toMatchObject(WINDOW)
  })

  it('REFUSES the right type in the wrong shape', async () => {
    // Stored happily before this change, then read by the scanner as no window at all.
    await expect(set('scans.event_window', { start: WINDOW.startsAt, end: WINDOW.endsAt }))
      .rejects.toThrow(/does not have the right shape/)
  })

  it('REFUSES a window that ends before it starts', async () => {
    await expect(set('scans.event_window', {
      startsAt: WINDOW.endsAt, endsAt: WINDOW.startsAt,
    })).rejects.toThrow(/endsAt must be after startsAt/)
  })

  it('REFUSES a date with no offset, because that silently means UTC', async () => {
    // The trap this setting has: a bare date is parsed as UTC midnight, which moves both edges
    // of the window by the local offset and misclassifies commits at the boundary.
    await expect(set('scans.event_window', { startsAt: '2026-10-03', endsAt: '2026-10-04' }))
      .rejects.toThrow(/does not have the right shape/)
  })

  it('accepts null, which means "do not classify by window"', async () => {
    await set('scans.event_window', null)
    expect(await getJson('scans.event_window')).toBeNull()
  })

  it('REFUSES only one end of a window', async () => {
    await expect(set('scans.event_window', { startsAt: WINDOW.startsAt }))
      .rejects.toThrow(/does not have the right shape/)
  })
})

describe('the other shapes that fail silently', () => {
  it('REFUSES an empty repository allow-list, which would refuse every submission', async () => {
    await expect(set('submissions.allowed_hosts', []))
      .rejects.toThrow(/does not have the right shape/)
  })

  it('REFUSES a host with a scheme or a path, and says what a host looks like', async () => {
    await expect(set('submissions.allowed_hosts', ['https://github.com/']))
      .rejects.toThrow(/bare hostname/)
  })

  it('ALLOWS an empty artifact host list — fetching nothing is a defensible choice', async () => {
    const row = await set('submissions.artifact_hosts', [])
    expect(row.value).toEqual([])
  })

  it('REFUSES a pricing table missing a rate', async () => {
    await expect(set('llm.model_pricing', { 'claude-sonnet-5': { inputPerMTok: 3 } }))
      .rejects.toThrow(/outputPerMTok/)
  })

  it('names every problem at once rather than one per attempt', async () => {
    const verdict = validateConfigValue({
      key: 'submissions.allowed_hosts',
      value: ['https://a.com', 'also bad'],
      valueType: 'json',
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toMatch(/0 .*bare hostname/)
    expect(verdict.detail).toMatch(/1 .*bare hostname/)
  })
})

describe('a bad value that got in another way is reported, not ignored', () => {
  it('readiness says the window is unusable rather than calling the event configured', async () => {
    await set('event.evaluation_date', '2026-10-04')
    // Straight to the table, bypassing the writer — the only route left.
    await query(
      `UPDATE app_config SET value = '{"startsAt":"nonsense","endsAt":"also nonsense"}'::jsonb
        WHERE key = 'scans.event_window'`)
    invalidateConfig()

    const report = await readinessReport('dev')
    const event = report.checks.find((c) => c.id === 'event')

    // The old check tested presence, so this passed while windowing was silently off.
    expect(event?.status).toBe('UNKNOWN')
    expect(event?.detail).toMatch(/unusable/)
  })
})

describe('a refusal has to say what is wrong', () => {
  const detailFor = (value: unknown) =>
    validateConfigValue({ key: 'scans.event_window', value, valueType: 'json' }).detail

  it('names the missing fields rather than saying "invalid input"', () => {
    // The union form of this schema reported `invalid_union`, which flattened to "Invalid
    // input" — a refusal an operator cannot act on, which is the failure being fixed here.
    const detail = detailFor({ start: '2026-10-03T12:00:00-04:00', end: '2026-10-04T12:00:00-04:00' })
    expect(detail).toMatch(/startsAt/)
    expect(detail).toMatch(/endsAt/)
    expect(detail).not.toMatch(/Invalid input/)
  })

  it('explains the offset requirement with an example, since that is the silent trap', () => {
    const detail = detailFor({ startsAt: '2026-10-03', endsAt: '2026-10-04' })
    expect(detail).toMatch(/ISO timestamp with a UTC offset/)
    expect(detail).toMatch(/2026-10-03T12:00:00-04:00/)
  })

  it('does not repeat the same problem once per union branch', () => {
    const detail = detailFor({ startsAt: '2026-10-03', endsAt: '2026-10-04' })
    const occurrences = detail.split('startsAt').length - 1
    expect(occurrences).toBe(1)
  })
})
