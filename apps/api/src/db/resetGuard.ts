/**
 * The guard that decides whether a destructive schema reset may proceed (E01-S02 acceptance 4).
 *
 * Deliberately a **pure module, importable without side effects**. It lives here rather than
 * inside the CLI because a unit test that imports a CLI entry point *executes* it — which, for a
 * command whose job is to drop a schema, is an incident rather than an inconvenience. That is
 * not hypothetical: it happened once during this build and the development database was saved
 * only by the process exiting before the DROP completed.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/** A database name that is unambiguously disposable. */
const DISPOSABLE_NAME = /(^crucible$|_test$|_dev$|_local$)/

export interface ResetGuardResult {
  allowed: boolean
  reason?: string
  /**
   * True when the operator must additionally pass `--yes`. Only a database whose name ends in
   * `_test` may skip confirmation, because that is the only name an automated harness owns.
   */
  requiresConfirmation: boolean
}

export function checkResetAllowed(databaseUrl: string, nodeEnv: string): ResetGuardResult {
  if (nodeEnv === 'production') {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: 'NODE_ENV is "production". db:reset is never permitted here.',
    }
  }

  let host: string
  let dbName: string
  try {
    const u = new URL(databaseUrl)
    host = u.hostname
    dbName = decodeURIComponent(u.pathname.replace(/^\//, ''))
  } catch {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: 'DATABASE_URL could not be parsed; refusing to reset.',
    }
  }

  if (!LOCAL_HOSTS.has(host)) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason:
        `DATABASE_URL host is "${host}". db:reset only runs against a loopback host ` +
        `(${[...LOCAL_HOSTS].join(', ')}).`,
    }
  }

  if (!DISPOSABLE_NAME.test(dbName)) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: `Database "${dbName}" is not recognisably a local development or test database.`,
    }
  }

  // Only a *_test database may be reset without an explicit confirmation flag. Keying the
  // bypass on NODE_ENV alone would let any process with NODE_ENV=test wipe whatever
  // DATABASE_URL happened to point at — including a developer's working database.
  return { allowed: true, requiresConfirmation: !dbName.endsWith('_test') }
}
