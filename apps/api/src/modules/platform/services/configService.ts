/**
 * Runtime configuration access (P3.6, P7.5, P11.2).
 *
 * Every behavioural knob in Crucible resolves through here. There is no code path that reads a
 * behavioural constant from a literal — that is what makes "nothing hardcoded" enforceable
 * rather than aspirational.
 *
 * Caching follows P11.2: a 60-second in-process TTL *plus* explicit invalidation on write. The
 * TTL alone is not relied upon, because an operator who raises the cost ceiling during a run
 * needs it to take effect now, not within a minute.
 */
import { createLogger } from '../../../lib/logger.js'
import { AppError } from '../../../lib/appError.js'
import { validateConfigValue } from './configSchemas.js'
import { currentPin, type RunPin } from '../../../lib/runScope.js'
import {
  selectAllConfig,
  selectAllFlags,
  selectConfig,
  selectConfigByModule,
  selectFlag,
  updateConfigValue,
  updateFlag,
  type ConfigRow,
  type FlagRow,
} from '../db/configDb.js'

const log = createLogger('platform', 'config')

const TTL_MS = 60_000

interface CacheEntry {
  value: unknown
  type: ConfigRow['value_type']
  loadedAt: number
}

const cache = new Map<string, CacheEntry>()
const flagCache = new Map<string, { enabled: boolean; loadedAt: number }>()
/** Which keys decide an outcome. Changes only by migration, so it is cached without a TTL. */
const outcomeCache = new Map<string, boolean>()

/** Invalidate one key, or the whole cache when called with no argument (P11.2). */
export function invalidateConfig(key?: string): void {
  if (key === undefined) {
    cache.clear()
    flagCache.clear()
    outcomeCache.clear()
    log.info('config cache cleared')
    return
  }
  cache.delete(key)
  flagCache.delete(key)
  outcomeCache.delete(key)
}

async function load(key: string): Promise<CacheEntry> {
  // Inside a run, an outcome-determining setting resolves from the pin taken when the run
  // opened (P4.4). This is the one place every read passes through, so pinning here makes it
  // true for every call site without any of them changing — and without any of them being able
  // to forget.
  const pin = currentPin()
  if (pin) {
    const pinned = pin.config[key]
    if (pinned) {
      return { value: pinned.value, type: pinned.type as ConfigRow['value_type'], loadedAt: Date.now() }
    }
    // Not pinned. Either it is an operational knob that should stay live, or it is an outcome
    // setting that was added without being declared as one. The declaration decides, and a key
    // that claims to affect the outcome yet is missing from the pin is a defect we refuse to
    // paper over with a live read.
    if (await affectsOutcome(key)) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Configuration key '${key}' affects the outcome but is not in this run's pin. A run ` +
          `must not read an outcome setting it did not pin (P4.4) — the run was opened before ` +
          `this key was declared, so re-open it rather than reading the live value.`,
      )
    }
  }

  const hit = cache.get(key)
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit

  const row = await selectConfig(key)
  if (!row) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Configuration key '${key}' is not declared. Config keys are created by migration, ` +
        `never at runtime (P7.5) — add it to a migration rather than writing it here.`,
    )
  }
  const entry: CacheEntry = { value: row.value, type: row.value_type, loadedAt: Date.now() }
  cache.set(key, entry)
  return entry
}

function typeMismatch(key: string, expected: string, actual: string): AppError {
  return new AppError(
    'INTERNAL_ERROR',
    `Configuration key '${key}' is declared as '${actual}' but was read as '${expected}'.`,
  )
}

export async function getNumber(key: string): Promise<number> {
  const e = await load(key)
  if (e.type !== 'number') throw typeMismatch(key, 'number', e.type)
  const n = Number(e.value)
  if (!Number.isFinite(n)) throw typeMismatch(key, 'number', typeof e.value)
  return n
}

export async function getString(key: string): Promise<string> {
  const e = await load(key)
  if (e.type !== 'string') throw typeMismatch(key, 'string', e.type)
  return String(e.value)
}

export async function getBoolean(key: string): Promise<boolean> {
  const e = await load(key)
  if (e.type !== 'boolean') throw typeMismatch(key, 'boolean', e.type)
  return e.value === true || e.value === 'true'
}

export async function getJson<T>(key: string): Promise<T> {
  const e = await load(key)
  if (e.type !== 'json') throw typeMismatch(key, 'json', e.type)
  return e.value as T
}

/**
 * Snapshot a set of keys for pinning onto a run (P4.4: config changes must not affect an
 * in-flight run). The returned object is stored on `run.pinned_config` and read back by the
 * run's stages instead of re-reading live config.
 */
export async function snapshotConfig(keys: readonly string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = (await load(key)).value
  return out
}

export async function listConfig(module?: string): Promise<ConfigRow[]> {
  return module ? selectConfigByModule(module) : selectAllConfig()
}

export async function setConfig(key: string, value: unknown, actor: string): Promise<ConfigRow> {
  /*
   * Checked BEFORE the write (E37). `value_type` has been declared on every row since E01 and
   * nothing read it, so a key declared `number` could be set to a string — and a json key could
   * be set to the right type in the wrong shape, which is worse, because the reader then
   * degrades silently instead of failing.
   */
  const existing = await selectConfig(key)
  if (!existing) {
    throw new AppError('NOT_FOUND', `Configuration key '${key}' does not exist or is not editable.`)
  }

  const verdict = validateConfigValue({ key, value, valueType: existing.value_type })
  if (!verdict.ok) {
    throw new AppError('UNPROCESSABLE', verdict.detail)
  }

  const row = await updateConfigValue(key, value, actor)
  if (!row) {
    throw new AppError('NOT_FOUND', `Configuration key '${key}' does not exist or is not editable.`)
  }
  invalidateConfig(key)
  log.info('config updated', { key, actor })
  return row
}

/** P12.3 — capability gating. An unknown flag is disabled, never assumed on. */
/**
 * Whether a key is declared as deciding an outcome.
 *
 * Cached alongside the value, because it is asked on every pinned read and changes only by
 * migration.
 */
async function affectsOutcome(key: string): Promise<boolean> {
  const known = outcomeCache.get(key)
  if (known !== undefined) return known
  const row = await selectConfig(key)
  const value = row?.affects_outcome ?? false
  outcomeCache.set(key, value)
  return value
}

/**
 * Everything a run must pin: every outcome-determining setting and every flag.
 *
 * Derived from the declaration rather than a hand-listed set of keys — a hand-listed set
 * silently stops covering settings added later, which is the failure the test-database reset
 * already had to be fixed for once.
 */
export async function captureRunPin(): Promise<RunPin> {
  const [rows, flags] = await Promise.all([selectAllConfig(), selectAllFlags()])

  const config: RunPin['config'] = {}
  for (const row of rows) {
    if (row.affects_outcome) config[row.key] = { value: row.value, type: row.value_type }
  }

  return {
    config,
    // Every flag, without exception: a flag change mid-run is always an outcome change.
    flags: Object.fromEntries(flags.map((f) => [f.key, f.enabled])),
    capturedAt: new Date().toISOString(),
  }
}

export async function isEnabled(key: string): Promise<boolean> {
  const pin = currentPin()
  if (pin) {
    const pinned = pin.flags[key]
    if (pinned !== undefined) return pinned
    throw new AppError(
      'INTERNAL_ERROR',
      `Feature flag '${key}' is not in this run's pin. Every flag is pinned when a run opens ` +
        `(P4.4), so a flag missing from it was declared after the run began — re-open the run ` +
        `rather than reading the live value.`,
    )
  }

  const hit = flagCache.get(key)
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.enabled
  const row = await selectFlag(key)
  const enabled = row?.enabled ?? false
  flagCache.set(key, { enabled, loadedAt: Date.now() })
  return enabled
}

export async function listFlags(): Promise<FlagRow[]> {
  return selectAllFlags()
}

export async function setFlag(key: string, enabled: boolean, actor: string): Promise<FlagRow> {
  const row = await updateFlag(key, enabled, actor)
  if (!row) throw new AppError('NOT_FOUND', `Feature flag '${key}' does not exist.`)
  invalidateConfig(key)
  log.info('feature flag updated', { key, enabled, actor })
  return row
}
