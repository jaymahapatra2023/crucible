/**
 * The run pin (E14, P4.4).
 *
 * Two properties, and the second is the one that was missing for the whole life of this system:
 * a run records what it executed under, and a run is actually HELD to it. `run.pinned_config`
 * existed from migration 004 and was read by nothing, so "a config change must not affect an
 * in-flight run" was a comment rather than a mechanism.
 */
import { describe, expect, it } from 'vitest'
import {
  comparePins, currentPin, describeDrift, isPinned, withRunPin, withoutRunPin, type RunPin,
} from './runScope.js'

const pin = (over: Partial<RunPin> = {}): RunPin => ({
  config: {
    'scoring.cut_line': { value: 6, type: 'number' },
    'scoring.context_budget_bytes': { value: 60000, type: 'number' },
  },
  flags: { 'feature.discovery.enabled': false },
  capturedAt: '2026-09-23T00:00:00Z',
  ...over,
})

describe('carrying a pin', () => {
  it('exposes the pin inside the scope', () => {
    withRunPin(pin(), () => {
      expect(currentPin()?.config['scoring.cut_line']?.value).toBe(6)
    })
  })

  it('exposes nothing outside any scope', () => {
    expect(currentPin()).toBeUndefined()
  })

  it('does not leak out of the scope', () => {
    withRunPin(pin(), () => undefined)
    expect(currentPin()).toBeUndefined()
  })

  it('can be stepped out of deliberately, for a read that must see live config', () => {
    // The motivating case: the cost ceiling an operator raises to unpause a batch.
    withRunPin(pin(), () => {
      expect(currentPin()).toBeDefined()
      withoutRunPin(() => expect(currentPin()).toBeUndefined())
      expect(currentPin()).toBeDefined()
    })
  })

  it('reports which keys it carries', () => {
    withRunPin(pin(), () => {
      expect(isPinned('scoring.cut_line')).toBe(true)
      expect(isPinned('batch.cost_ceiling_usd')).toBe(false)
    })
  })

  it('reports nothing as pinned outside a scope', () => {
    expect(isPinned('scoring.cut_line')).toBe(false)
  })
})

describe('comparing two runs', () => {
  it('calls identical pins alike', () => {
    expect(comparePins(pin(), pin()).alike).toBe(true)
  })

  it('names a setting that moved between the runs', () => {
    const drift = comparePins(pin(), pin({
      config: {
        'scoring.cut_line': { value: 10, type: 'number' },
        'scoring.context_budget_bytes': { value: 60000, type: 'number' },
      },
    }))
    expect(drift.alike).toBe(false)
    expect(drift.differences).toEqual([{ key: 'scoring.cut_line', left: 6, right: 10 }])
  })

  it('catches a FLAG that moved, which is what discovery being on or off looks like', () => {
    const drift = comparePins(pin(), pin({ flags: { 'feature.discovery.enabled': true } }))
    expect(drift.alike).toBe(false)
    expect(drift.differences[0]).toMatchObject({ key: 'feature.discovery.enabled' })
  })

  it('catches a key present in one run and absent from the other', () => {
    const drift = comparePins(pin(), pin({
      config: { 'scoring.cut_line': { value: 6, type: 'number' } },
    }))
    expect(drift.alike).toBe(false)
    expect(drift.differences).toEqual([
      { key: 'scoring.context_budget_bytes', left: 60000, right: undefined },
    ])
  })

  it('treats an EMPTY pin as no pin — every row predating pinning carries one', () => {
    // The column defaults to `{}`, so this is the ordinary case in any deployment that has run
    // before. Comparing two empty pins as "identical" would report agreement about nothing.
    const drift = comparePins(pin(), pin({ config: {}, flags: {} }))
    expect(drift.alike).toBe(false)
    expect(drift.differences[0]?.key).toMatch(/no configuration was recorded/i)
  })

  it('survives a malformed pin rather than throwing', () => {
    // A partially written row, or one from an older shape. Throwing here would take down the
    // variance report over a historical artefact.
    expect(() => comparePins({} as never, pin())).not.toThrow()
    expect(comparePins({} as never, pin()).alike).toBe(false)
  })

  it('refuses to call an unpinned run alike — unknown is not the same as identical', () => {
    // A run that predates pinning tells us nothing about what it ran under. Reporting it as
    // matching would be the confident-but-unfounded claim this whole area exists to avoid.
    expect(comparePins(null, pin()).alike).toBe(false)
    expect(comparePins(pin(), null).alike).toBe(false)
    expect(comparePins(null, null).alike).toBe(false)
  })

  it('orders differences deterministically, so two reads agree', () => {
    const wide = (n: number) => pin({
      config: {
        zulu: { value: n, type: 'number' },
        alpha: { value: n, type: 'number' },
        mike: { value: n, type: 'number' },
      },
    })
    expect(comparePins(wide(1), wide(2)).differences.map((d) => d.key))
      .toEqual(['alpha', 'mike', 'zulu'])
  })
})

describe('describing drift to a reviewer', () => {
  it('says plainly when two runs were alike', () => {
    expect(describeDrift(comparePins(pin(), pin()))).toMatch(/identical settings/i)
  })

  it('warns that a difference may be the configuration rather than the submissions', () => {
    // A variance flag normally reads as model instability. When the settings moved, it is
    // measuring the settings, and a reviewer who does not know that will read it wrongly.
    const text = describeDrift(comparePins(pin(), pin({ config: {} })))
    expect(text).toMatch(/NOT executed alike/)
    expect(text).toMatch(/rather than the submissions/i)
  })

  it('names the first few keys and counts the rest rather than listing everything', () => {
    const many = (offset: number) => Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`k${i}`, { value: i + offset, type: 'number' }]))
    const text = describeDrift(
      comparePins(pin({ config: many(0) }), pin({ config: many(100) })))
    expect(text).toMatch(/and 5 more/)
  })
})
