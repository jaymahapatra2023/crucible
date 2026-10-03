/**
 * The configuration a run is pinned to, carried ambiently (E14-S02, P4.4).
 *
 * P4.4 asks that "config changes do not affect an in-flight run". Until now that was recorded
 * and not enforced: `run.pinned_config` was written by the batch orchestrator and read by
 * nothing, while the scoring path resolved every value live. A setting changed at 2am genuinely
 * did reshape the second half of a cohort, and nothing said so.
 *
 * Held in AsyncLocalStorage for the same reason the correlation id is: a pin threaded through
 * signatures by hand is a pin that gets dropped at the first refactor, and it would be dropped
 * silently — in exactly the services where being silent matters most.
 *
 * The strictness is deliberate. Inside a scope, reading a key the pin does not carry is an
 * ERROR, never a quiet fall-through to the live value. A fall-through would reintroduce the bug
 * for precisely the settings nobody remembered to include, which is the population most likely
 * to contain the next one.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface PinnedValue {
  value: unknown
  type: string
}

export interface RunPin {
  /** Outcome-determining settings, as declared by `app_config.affects_outcome`. */
  config: Record<string, PinnedValue>
  /** Every feature flag. A flag change mid-run is always an outcome change. */
  flags: Record<string, boolean>
  capturedAt: string
}

const storage = new AsyncLocalStorage<RunPin>()

/** Run `fn` with every outcome setting resolved from `pin` rather than from the database. */
export function withRunPin<T>(pin: RunPin, fn: () => T): T {
  return storage.run(pin, fn)
}

/** The active pin, or undefined outside any run. */
export function currentPin(): RunPin | undefined {
  return storage.getStore()
}

/**
 * Run `fn` with no pin, even inside one.
 *
 * For the handful of reads that must see the live value while a run is in flight — the cost
 * ceiling an operator raises to unpause a batch is the motivating case. Rare and explicit, so
 * that using it is a decision rather than an accident.
 */
export function withoutRunPin<T>(fn: () => T): T {
  return storage.exit(fn)
}

export function isPinned(key: string): boolean {
  const pin = storage.getStore()
  return pin !== undefined && key in pin.config
}

/**
 * Whether a stored value is a real pin.
 *
 * Rows written before pinning existed carry `{}` from the column default, and a partially
 * written one would carry a config with no flags. Both mean "we do not know what this ran
 * under", which is a different answer from "it ran under nothing".
 */
function hasPin(pin: RunPin | null): pin is RunPin {
  return pin !== null
    && typeof pin === 'object'
    && typeof pin.config === 'object' && pin.config !== null
    && typeof pin.flags === 'object' && pin.flags !== null
    && Object.keys(pin.config).length > 0
}

/** Whether two runs were executed under the same settings, and where they differed. */
export interface PinDrift {
  alike: boolean
  /** Keys whose value differs, with both values, for a reader who needs to judge the gap. */
  differences: Array<{ key: string; left: unknown; right: unknown }>
}

export function comparePins(left: RunPin | null, right: RunPin | null): PinDrift {
  // A run with no pin predates pinning. That is not "the same" — it is unknown, and reporting
  // it as alike would be the confident-but-unfounded claim this whole area exists to avoid.
  //
  // An EMPTY pin counts as no pin. Every row written before pinning existed defaults to `{}`,
  // so this is the ordinary case in any deployment that has run before, not an edge case.
  const a = hasPin(left) ? left : null
  const b = hasPin(right) ? right : null
  if (!a || !b) {
    return {
      alike: false,
      differences: [{
        key: '(no configuration was recorded for one of these)',
        left: a ? 'pinned' : null,
        right: b ? 'pinned' : null,
      }],
    }
  }

  const differences: PinDrift['differences'] = []
  const keys = new Set([...Object.keys(a.config), ...Object.keys(b.config)])
  for (const key of [...keys].sort()) {
    const left0 = a.config[key]?.value
    const right0 = b.config[key]?.value
    if (JSON.stringify(left0) !== JSON.stringify(right0)) {
      differences.push({ key, left: left0, right: right0 })
    }
  }

  const flags = new Set([...Object.keys(a.flags), ...Object.keys(b.flags)])
  for (const key of [...flags].sort()) {
    if (a.flags[key] !== b.flags[key]) {
      differences.push({ key, left: a.flags[key], right: b.flags[key] })
    }
  }

  return { alike: differences.length === 0, differences }
}

/** One sentence naming the drift, for a reviewer reading a variance flag. */
export function describeDrift(drift: PinDrift): string {
  if (drift.alike) return 'Both runs executed under identical settings.'

  const named = drift.differences.slice(0, 4).map((d) => d.key).join(', ')
  const rest = drift.differences.length > 4 ? `, and ${drift.differences.length - 4} more` : ''
  return `These runs were NOT executed alike: ${named}${rest} differed. Differences between `
    + `them may reflect the configuration change rather than the submissions.`
}
