/**
 * The production path to a first admin (`pnpm user:create`).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { createUser, parseCreateUserArgs } from '../../src/db/cli/createUser.js'
import { verifyPassword } from '../../src/lib/password.js'
import { query } from '../../src/db/pool.js'

beforeEach(async () => { await resetDatabase() })

describe('arguments', () => {
  it('takes the password from the environment, never from the command line', () => {
    const input = parseCreateUserArgs(['--email', 'Admin@Example.org', '--name', 'A B'],
      { CRUCIBLE_USER_PASSWORD: 'a-long-passphrase' })
    expect(input).toEqual({ email: 'admin@example.org', name: 'A B', role: 'admin', password: 'a-long-passphrase' })
    expect(() => parseCreateUserArgs(['--email', 'a@b.c', '--name', 'A B'], {})).toThrow(/CRUCIBLE_USER_PASSWORD/)
  })

  it('refuses a role it does not know', () => {
    expect(() => parseCreateUserArgs(['--email', 'a@b.c', '--name', 'A B', '--role', 'root'],
      { CRUCIBLE_USER_PASSWORD: 'a-long-passphrase' })).toThrow(/--role/)
  })
})

describe('creating', () => {
  it('stores a hash the login path verifies, and updates rather than duplicates', async () => {
    expect(await createUser({ email: 'a@b.c', name: 'A', role: 'admin', password: 'first-passphrase' })).toEqual({ created: true })
    expect(await createUser({ email: 'a@b.c', name: 'A', role: 'organiser', password: 'second-passphrase' })).toEqual({ created: false })

    const rows = await query<{ password_hash: string; role: string; active: boolean }>(
      'SELECT password_hash, role, active FROM crucible_user WHERE email = $1', ['a@b.c'])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.role).toBe('organiser')
    expect(rows.rows[0]!.active).toBe(true)
    expect(await verifyPassword('second-passphrase', rows.rows[0]!.password_hash)).toBe(true)
    expect(rows.rows[0]!.password_hash).not.toContain('second-passphrase')
  })
})
