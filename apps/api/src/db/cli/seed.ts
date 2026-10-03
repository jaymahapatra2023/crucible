#!/usr/bin/env node
/**
 * `pnpm db:seed` — idempotent development seed.
 *
 * Creates the initial staff accounts so the API is usable immediately. Refuses to seed a
 * default-credential admin in production: a well-known password on the account that can approve
 * a rubric and finalise a shortlist is the kind of convenience that becomes an incident.
 */
import { pathToFileURL } from 'node:url'
import { closePool, query } from '../pool.js'
import { loadEnv } from '../../config/env.js'
import { hashPassword } from '../../lib/password.js'

const DEV_USERS = [
  { email: 'admin@crucible.local', name: 'Local Admin', role: 'admin', password: 'crucible-dev-admin' },
  { email: 'organiser@crucible.local', name: 'Local Organiser', role: 'organiser', password: 'crucible-dev-organiser' },
  { email: 'reviewer@crucible.local', name: 'Local Reviewer', role: 'reviewer', password: 'crucible-dev-reviewer' },
]

export async function main(): Promise<void> {
  const env = loadEnv()
  if (env.NODE_ENV === 'production') {
    console.error('\nREFUSED: db:seed creates accounts with known passwords and never runs in production.\n')
    process.exit(2)
  }

  for (const u of DEV_USERS) {
    const hash = await hashPassword(u.password)
    const res = await query(
      `INSERT INTO crucible_user (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [u.email, u.name, hash, u.role],
    )
    console.log(`  ${res.rowCount === 1 ? 'created' : 'exists '} ${u.email} (${u.role})`)
  }

  console.log('\nSeed complete. Development passwords are listed in apps/api/src/db/cli/seed.ts.')
}

/** Only run when executed directly — never on import (see db/resetGuard.ts). */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error('\nSeed failed:\n', err instanceof Error ? err.message : err)
      await closePool().catch(() => undefined)
      process.exit(1)
    })
}
