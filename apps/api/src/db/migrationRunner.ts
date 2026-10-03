/**
 * Forward-only, idempotent migration runner (E01-S02).
 *
 * Contract:
 *  - Migrations are `NNN_name.sql`, applied in numeric order, recorded in `schema_migrations`.
 *  - Re-running against an up-to-date database applies nothing and exits 0.
 *  - Each file runs inside one transaction: a failure leaves no partial migration behind.
 *  - An advisory lock serialises concurrent runners, so two API instances booting together
 *    cannot both apply migration 007.
 *  - Applied files are checksummed. Editing a migration that has already run is refused —
 *    forward-only means a change is a new file, never an edit to history.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../lib/logger.js'
import { AppError } from '../lib/appError.js'
import { getPool, query, type DbClient } from './pool.js'

const log = createLogger('platform', 'migrations')

/** Namespaced advisory lock id; arbitrary but stable. */
const LOCK_ID = 8_142_339

const FILENAME = /^(\d{3,4})_([a-z0-9_]+)\.sql$/

export interface MigrationFile {
  version: number
  name: string
  filename: string
  sql: string
  checksum: string
}

export interface MigrateResult {
  applied: MigrationFile[]
  alreadyApplied: number
  /** True when nothing needed doing — the no-op case E01-S02 acceptance 2 requires. */
  upToDate: boolean
}

export async function ensureMigrationTable(client?: DbClient): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version      INTEGER      PRIMARY KEY,
       name         TEXT         NOT NULL,
       checksum     CHAR(64)     NOT NULL,
       applied_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
       duration_ms  INTEGER      NOT NULL
     )`,
    [],
    client,
  )
}

/** Read and validate every migration file in `dir`, ordered by version. */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    throw new AppError('INTERNAL_ERROR', `Migration directory '${dir}' could not be read.`, { cause: err })
  }

  const files: MigrationFile[] = []
  const seen = new Map<number, string>()

  for (const filename of entries.filter((f) => f.endsWith('.sql')).sort()) {
    const m = FILENAME.exec(filename)
    if (!m) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Migration '${filename}' does not match NNN_lower_snake_name.sql.`,
      )
    }
    const version = Number(m[1])
    const existing = seen.get(version)
    if (existing) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Duplicate migration version ${version}: '${existing}' and '${filename}'.`,
      )
    }
    seen.set(version, filename)
    const sql = await readFile(join(dir, filename), 'utf8')
    files.push({
      version,
      name: m[2] ?? filename,
      filename,
      sql,
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
    })
  }

  return files.sort((a, b) => a.version - b.version)
}

interface AppliedRow {
  version: number
  name: string
  checksum: string
}

/**
 * Apply every pending migration in order. Returns what was applied; applying nothing is the
 * expected outcome on an up-to-date database and is not an error.
 */
export async function migrate(dir: string): Promise<MigrateResult> {
  const files = await loadMigrations(dir)
  const client = await getPool().connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    await ensureMigrationTable(client)

    const appliedRows = await client.query<AppliedRow>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    const applied = new Map(appliedRows.rows.map((r) => [r.version, r]))

    // Forward-only integrity: a file that already ran must not have changed.
    for (const file of files) {
      const prior = applied.get(file.version)
      if (prior && prior.checksum !== file.checksum) {
        throw new AppError(
          'CONFLICT',
          `Migration ${file.filename} was modified after it was applied ` +
            `(recorded ${prior.checksum.slice(0, 12)}…, file is ${file.checksum.slice(0, 12)}…). ` +
            `Migrations are forward-only: add a new migration instead of editing this one.`,
        )
      }
    }

    const pending = files.filter((f) => !applied.has(f.version))
    if (pending.length === 0) {
      log.info('database is up to date', { appliedCount: applied.size })
      return { applied: [], alreadyApplied: applied.size, upToDate: true }
    }

    const done: MigrationFile[] = []
    for (const file of pending) {
      const started = Date.now()
      try {
        await client.query('BEGIN')
        await client.query(file.sql)
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [file.version, file.name, file.checksum, Date.now() - started],
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw new AppError('INTERNAL_ERROR', `Migration ${file.filename} failed and was rolled back.`, {
          cause: err,
        })
      }
      log.info('migration applied', { version: file.version, name: file.name, durationMs: Date.now() - started })
      done.push(file)
    }

    return { applied: done, alreadyApplied: applied.size, upToDate: false }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined)
    client.release()
  }
}

/** Versions recorded as applied, ascending. Used by the readiness probe and tests. */
export async function appliedVersions(): Promise<number[]> {
  await ensureMigrationTable()
  const res = await query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
  return res.rows.map((r) => r.version)
}
