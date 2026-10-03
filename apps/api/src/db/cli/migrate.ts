#!/usr/bin/env node
/**
 * `pnpm migrate` — apply pending migrations and exit.
 *
 * Exits 0 when the database is already up to date (E01-S02 acceptance 2), so the same command
 * is safe in a container entrypoint and in CI.
 */
import { pathToFileURL } from 'node:url'
import { closePool } from '../pool.js'
import { migrate } from '../migrationRunner.js'
import { migrationsDir } from '../../lib/paths.js'
import { loadEnv, ConfigurationError } from '../../config/env.js'

export async function main(): Promise<void> {
  const env = loadEnv()
  const dir = migrationsDir()
  console.log(`crucible migrate — ${dir} → ${redactUrl(env.DATABASE_URL)}`)

  const result = await migrate(dir)
  if (result.upToDate) {
    console.log(`Up to date. ${result.alreadyApplied} migration(s) already applied.`)
    return
  }
  for (const m of result.applied) console.log(`  applied ${m.filename}`)
  console.log(`Applied ${result.applied.length} migration(s); ${result.alreadyApplied + result.applied.length} total.`)
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '(unparseable connection string)'
  }
}

/** Only run when executed directly — never on import (see db/resetGuard.ts). */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      if (err instanceof ConfigurationError) console.error(`\n${err.message}\n`)
      else console.error('\nMigration failed:\n', err instanceof Error ? err.message : err)
      await closePool().catch(() => undefined)
      process.exit(1)
    })
}
