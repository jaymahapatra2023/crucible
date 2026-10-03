/**
 * Migration runner integration tests (E01-S02).
 *
 * Against a real Postgres, because the properties under test — transactional rollback, advisory
 * locking, checksum enforcement — are properties of the database, not of the code around it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, loadMigrations, ensureMigrationTable } from '../../src/db/migrationRunner.js'
import { query } from '../../src/db/pool.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crucible-mig-'))
  await ensureMigrationTable()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await query('DROP TABLE IF EXISTS mig_probe_a, mig_probe_b CASCADE')
  await query("DELETE FROM schema_migrations WHERE version >= 900")
})

const write = (name: string, sql: string) => writeFile(join(dir, name), sql, 'utf8')

describe('loadMigrations — validation', () => {
  it('orders by numeric version, not lexically', async () => {
    await write('002_b.sql', 'SELECT 1')
    await write('010_c.sql', 'SELECT 1')
    await write('001_a.sql', 'SELECT 1')
    const files = await loadMigrations(dir)
    expect(files.map((f) => f.version)).toEqual([1, 2, 10])
  })

  it('rejects a badly named file rather than skipping it silently', async () => {
    await write('not-a-migration.sql', 'SELECT 1')
    await expect(loadMigrations(dir)).rejects.toThrow(/NNN_lower_snake_name/)
  })

  it('rejects duplicate version numbers', async () => {
    await write('001_a.sql', 'SELECT 1')
    await write('001_b.sql', 'SELECT 2')
    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration version/)
  })

  it('computes a checksum insensitive to line endings', async () => {
    await write('001_a.sql', 'SELECT 1;\nSELECT 2;\n')
    const a = (await loadMigrations(dir))[0]
    await write('001_a.sql', 'SELECT 1;\r\nSELECT 2;\r\n')
    const b = (await loadMigrations(dir))[0]
    expect(a?.checksum).toBe(b?.checksum)
  })
})

describe('migrate — application', () => {
  it('applies pending migrations and records them', async () => {
    await write('900_probe_a.sql', 'CREATE TABLE IF NOT EXISTS mig_probe_a (id INT)')
    const result = await migrate(dir)
    expect(result.upToDate).toBe(false)
    expect(result.applied.map((m) => m.version)).toContain(900)

    const rows = await query("SELECT 1 FROM information_schema.tables WHERE table_name = 'mig_probe_a'")
    expect(rows.rowCount).toBe(1)
  })

  it('is a no-op on a second run (acceptance 2)', async () => {
    await write('900_probe_a.sql', 'CREATE TABLE IF NOT EXISTS mig_probe_a (id INT)')
    await migrate(dir)
    const second = await migrate(dir)
    expect(second.upToDate).toBe(true)
    expect(second.applied).toHaveLength(0)
  })

  it('rolls back a failing migration entirely, leaving nothing half-applied', async () => {
    await write('901_broken.sql', `
      CREATE TABLE mig_probe_b (id INT);
      THIS IS NOT VALID SQL;
    `)
    await expect(migrate(dir)).rejects.toThrow(/901_broken\.sql failed and was rolled back/)

    const table = await query("SELECT 1 FROM information_schema.tables WHERE table_name = 'mig_probe_b'")
    expect(table.rowCount).toBe(0)
    const recorded = await query('SELECT 1 FROM schema_migrations WHERE version = 901')
    expect(recorded.rowCount).toBe(0)
  })

  it('refuses a migration edited after it was applied (forward-only)', async () => {
    await write('900_probe_a.sql', 'CREATE TABLE IF NOT EXISTS mig_probe_a (id INT)')
    await migrate(dir)
    await write('900_probe_a.sql', 'CREATE TABLE IF NOT EXISTS mig_probe_a (id INT, extra TEXT)')
    await expect(migrate(dir)).rejects.toThrow(/was modified after it was applied/)
  })

  it('serialises concurrent runners via the advisory lock', async () => {
    await write('900_probe_a.sql', 'CREATE TABLE IF NOT EXISTS mig_probe_a (id INT)')
    const [a, b] = await Promise.all([migrate(dir), migrate(dir)])
    // Exactly one of the two applied it; the other found the database up to date.
    expect([a.applied.length, b.applied.length].sort()).toEqual([0, 1])
  })
})
