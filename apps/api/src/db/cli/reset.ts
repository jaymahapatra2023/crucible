#!/usr/bin/env node
/**
 * `pnpm db:reset` — drop and rebuild the schema. **Local development only.**
 *
 * The decision logic lives in `db/resetGuard.ts`; this file is only the entry point. It also
 * refuses to run when merely *imported*, so that importing anything nearby cannot trigger a
 * destructive operation as a side effect.
 */
import { pathToFileURL } from 'node:url'
import { closePool, getPool } from '../pool.js'
import { migrate } from '../migrationRunner.js'
import { migrationsDir } from '../../lib/paths.js'
import { loadEnv } from '../../config/env.js'
import { checkResetAllowed } from '../resetGuard.js'

export async function runReset(argv: readonly string[]): Promise<void> {
  const env = loadEnv()
  const guard = checkResetAllowed(env.DATABASE_URL, env.NODE_ENV)
  if (!guard.allowed) {
    console.error(`\nREFUSED: ${guard.reason}\n`)
    process.exit(2)
  }
  if (guard.requiresConfirmation && !argv.includes('--yes')) {
    console.error('\nREFUSED: db:reset destroys all data. Re-run with --yes to confirm.\n')
    process.exit(2)
  }

  const pool = getPool()
  console.log('Dropping schema "public" …')
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE')
  await pool.query('CREATE SCHEMA public')
  console.log('Re-applying migrations …')
  const result = await migrate(migrationsDir())
  console.log(`Reset complete. ${result.applied.length} migration(s) applied.`)
}

/** Only run when executed directly — never on import (see resetGuard.ts). */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  runReset(process.argv)
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error('\ndb:reset failed:\n', err instanceof Error ? err.message : err)
      await closePool().catch(() => undefined)
      process.exit(1)
    })
}
