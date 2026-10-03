#!/usr/bin/env node
/**
 * `pnpm user:create` — create or update one staff account, in any environment.
 *
 * The seed refuses to run in production because it creates accounts with KNOWN passwords. This
 * is the production path: the password comes from `CRUCIBLE_USER_PASSWORD` in the environment
 * (never an argument, so it is not in shell history or `ps`), is hashed with the same scrypt
 * the login route verifies, and is never printed. Re-running for an existing address updates the
 * password and role, so a locked-out admin is one command from back in.
 *
 *   CRUCIBLE_USER_PASSWORD='…' node apps/api/dist/db/cli/createUser.js \
 *     --email you@example.org --name "Your Name" --role admin
 */
import { pathToFileURL } from 'node:url'
import { closePool, query } from '../pool.js'
import { hashPassword } from '../../lib/password.js'
import { loadEnv, ConfigurationError } from '../../config/env.js'

const ROLES = ['admin', 'organiser', 'reviewer', 'viewer'] as const
type Role = (typeof ROLES)[number]

export interface CreateUserInput {
  email: string
  name: string
  role: Role
  password: string
}

export function parseCreateUserArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CreateUserInput {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  const email = get('--email')?.trim().toLowerCase() ?? ''
  const name = get('--name')?.trim() ?? ''
  const role = (get('--role') ?? 'admin').trim() as Role
  const password = env['CRUCIBLE_USER_PASSWORD'] ?? ''

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('--email must be an address.')
  if (name.length < 2) throw new Error('--name is required.')
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}.`)
  if (password.length < 12) {
    throw new Error('CRUCIBLE_USER_PASSWORD must be set in the environment, at least 12 characters.')
  }
  return { email, name, role, password }
}

export async function createUser(input: CreateUserInput): Promise<{ created: boolean }> {
  const row = await query<{ inserted: boolean }>(
    `INSERT INTO crucible_user (email, display_name, password_hash, role, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (email) DO UPDATE
       SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role, active = TRUE, deleted_at = NULL, deleted_by = NULL,
           delete_reason = NULL
     RETURNING (xmax = 0) AS inserted`,
    [input.email, input.name, await hashPassword(input.password), input.role])
  return { created: row.rows[0]?.inserted ?? false }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadEnv()
  const input = parseCreateUserArgs(argv, process.env)
  const result = await createUser(input)
  // The address and the role, never the password (P8.3).
  console.log(`${result.created ? 'Created' : 'Updated'} ${input.role} ${input.email}.`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .catch((err: unknown) => {
      process.stderr.write(`\n${err instanceof ConfigurationError || err instanceof Error ? err.message : String(err)}\n\n`)
      process.exitCode = 1
    })
    .finally(() => closePool())
}
