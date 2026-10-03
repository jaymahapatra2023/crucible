/**
 * All SQL for platform configuration (P1.2 — SQL lives in the module's db/ layer).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'

export interface ConfigRow {
  key: string
  value: unknown
  value_type: 'string' | 'number' | 'boolean' | 'json'
  description: string
  module: string
  editable: boolean
  /** Whether changing this changes what a submission scores, as opposed to how the run goes. */
  affects_outcome: boolean
  updated_by: string | null
  updated_at: Date
}

/** Selected everywhere, so the shape cannot drift between the three read paths. */
const CONFIG_COLS = `key, value, value_type, description, module, editable,
                     affects_outcome, updated_by, updated_at`

export async function selectConfig(key: string): Promise<ConfigRow | null> {
  return queryOne<ConfigRow>(
    `SELECT ${CONFIG_COLS} FROM app_config WHERE key = $1`,
    [key],
  )
}

export async function selectAllConfig(): Promise<ConfigRow[]> {
  const res = await query<ConfigRow>(
    `SELECT ${CONFIG_COLS} FROM app_config ORDER BY module, key`,
  )
  return res.rows
}

export async function selectConfigByModule(module: string): Promise<ConfigRow[]> {
  const res = await query<ConfigRow>(
    `SELECT ${CONFIG_COLS} FROM app_config WHERE module = $1 ORDER BY key`,
    [module],
  )
  return res.rows
}

/** Update an existing key. Returns null when the key does not exist — config keys are declared
 *  by migration, never created ad hoc by a write (P7.5). */
export async function updateConfigValue(
  key: string,
  value: unknown,
  updatedBy: string,
  client?: DbClient,
): Promise<ConfigRow | null> {
  return queryOne<ConfigRow>(
    `UPDATE app_config
        SET value = $2::jsonb, updated_by = $3, updated_at = now()
      WHERE key = $1 AND editable
      RETURNING ${CONFIG_COLS}`,
    [key, JSON.stringify(value), updatedBy],
    client,
  )
}

export interface FlagRow {
  key: string
  enabled: boolean
  description: string
}

export async function selectFlag(key: string): Promise<FlagRow | null> {
  return queryOne<FlagRow>('SELECT key, enabled, description FROM feature_flag WHERE key = $1', [key])
}

export async function selectAllFlags(): Promise<FlagRow[]> {
  const res = await query<FlagRow>('SELECT key, enabled, description FROM feature_flag ORDER BY key')
  return res.rows
}

export async function updateFlag(key: string, enabled: boolean, updatedBy: string): Promise<FlagRow | null> {
  return queryOne<FlagRow>(
    `UPDATE feature_flag SET enabled = $2, updated_by = $3, updated_at = now()
      WHERE key = $1 RETURNING key, enabled, description`,
    [key, enabled, updatedBy],
  )
}
