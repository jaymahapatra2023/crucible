/**
 * Postgres connection pool and the query seam every module's `db/` layer uses.
 *
 * All SQL in Crucible goes through `query`/`tx` so that correlation ids (P9.2), slow-query
 * warnings (P11.3) and error translation happen in exactly one place rather than per call site.
 */
import pg from 'pg'
import { loadEnv } from '../config/env.js'
import { createLogger } from '../lib/logger.js'
import { AppError } from '../lib/appError.js'

const log = createLogger('platform', 'db')

/** Postgres returns BIGINT as a string by default; Crucible's ids fit in a JS number safely. */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v))
/** NUMERIC must stay a string→number conversion we control, not silent precision loss. */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => Number(v))

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (pool) return pool
  const env = loadEnv()
  pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.NODE_ENV === 'test' ? 5 : 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'crucible-api',
  })
  pool.on('error', (err) => {
    log.error('idle client error', { err })
  })
  return pool
}

export async function closePool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = null
  await p.end()
}

/** Queries slower than this are logged at warn so P11.3 regressions surface without a profiler. */
const SLOW_QUERY_MS = 500

export interface QueryResult<T> {
  rows: T[]
  rowCount: number
}

/**
 * Run a parameterised query. Parameters are always bound — Crucible never interpolates values
 * into SQL text (P8.5: the DB layer does not trust the layer above it).
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  client?: pg.PoolClient,
): Promise<QueryResult<T>> {
  const started = Date.now()
  const runner = client ?? getPool()
  try {
    const res = await runner.query<T>(text, params as unknown[])
    const ms = Date.now() - started
    if (ms > SLOW_QUERY_MS) {
      log.warn('slow query', { durationMs: ms, sql: firstLine(text) })
    }
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length }
  } catch (err) {
    log.error('query failed', { err, sql: firstLine(text) })
    throw translate(err)
  }
}

/** Single-row convenience. Returns null rather than throwing when nothing matched. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  client?: pg.PoolClient,
): Promise<T | null> {
  const res = await query<T>(text, params, client)
  return res.rows[0] ?? null
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any throw.
 * Nested calls reuse the outer client so a service composed of services still commits once.
 */
export async function tx<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  existing?: pg.PoolClient,
): Promise<T> {
  if (existing) return fn(existing)

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      log.error('rollback failed', { err: rollbackErr })
    }
    throw err
  } finally {
    client.release()
  }
}

/** Translate Postgres error codes into AppErrors so routes report accurate statuses (P6.2). */
function translate(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code
  const detail = (err as { detail?: string } | null)?.detail
  switch (code) {
    case '23505':
      return new AppError('ALREADY_EXISTS', 'That record already exists.', { cause: err, details: detail })
    case '23503':
      return new AppError('CONFLICT', 'A referenced record does not exist.', { cause: err, details: detail })
    case '23514':
      return new AppError('UNPROCESSABLE', 'A database constraint rejected this value.', { cause: err, details: detail })
    case '40001':
      return new AppError('CONFLICT', 'Concurrent update; retry the operation.', { cause: err, retryable: true })
    case '57014':
      return new AppError('TIMEOUT', 'The database cancelled a statement that ran too long.', { cause: err, retryable: true })
    default:
      return err
  }
}

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0]?.slice(0, 160) ?? ''
}

/** Re-exported so module `db/` files type their client parameter without importing pg directly. */
export type DbClient = pg.PoolClient
