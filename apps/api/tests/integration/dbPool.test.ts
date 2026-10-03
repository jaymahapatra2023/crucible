/**
 * Database seam integration tests (P6.2 error translation, P8.5 layered trust).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { query, queryOne, tx } from '../../src/db/pool.js'
import { AppError } from '../../src/lib/appError.js'

beforeEach(async () => {
  await resetDatabase()
  await query('DROP TABLE IF EXISTS tx_probe')
  await query('CREATE TABLE IF NOT EXISTS tx_probe (id INT PRIMARY KEY, note TEXT)')
  await query('TRUNCATE tx_probe')
})

describe('transactions', () => {
  it('commits on success', async () => {
    await tx(async (client) => {
      await query('INSERT INTO tx_probe (id, note) VALUES (1, $1)', ['kept'], client)
    })
    expect((await query('SELECT * FROM tx_probe')).rowCount).toBe(1)
  })

  it('rolls back everything when the callback throws', async () => {
    await expect(tx(async (client) => {
      await query('INSERT INTO tx_probe (id, note) VALUES (1, $1)', ['a'], client)
      await query('INSERT INTO tx_probe (id, note) VALUES (2, $1)', ['b'], client)
      throw new Error('business rule failed')
    })).rejects.toThrow('business rule failed')

    expect((await query('SELECT * FROM tx_probe')).rowCount).toBe(0)
  })

  it('reuses an outer client so a service composed of services commits once', async () => {
    await tx(async (outer) => {
      await query('INSERT INTO tx_probe (id) VALUES (1)', [], outer)
      // An inner "service" joining the same transaction.
      await tx(async (inner) => {
        expect(inner).toBe(outer)
        await query('INSERT INTO tx_probe (id) VALUES (2)', [], inner)
      }, outer)
    })
    expect((await query('SELECT * FROM tx_probe')).rowCount).toBe(2)
  })

  it('rolls back the inner work too when the outer transaction fails', async () => {
    await expect(tx(async (outer) => {
      await tx(async (inner) => {
        await query('INSERT INTO tx_probe (id) VALUES (1)', [], inner)
      }, outer)
      throw new Error('outer failed')
    })).rejects.toThrow('outer failed')
    expect((await query('SELECT * FROM tx_probe')).rowCount).toBe(0)
  })
})

describe('error translation (P6.2)', () => {
  it('maps a unique violation to ALREADY_EXISTS', async () => {
    await query('INSERT INTO tx_probe (id) VALUES (1)')
    const err = await query('INSERT INTO tx_probe (id) VALUES (1)').catch((e) => e as AppError)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('ALREADY_EXISTS')
    expect((err as AppError).status).toBe(409)
  })

  it('maps a check-constraint violation to UNPROCESSABLE', async () => {
    const err = await query(
      `INSERT INTO run (kind, status, correlation_id) VALUES ('NOT_A_KIND', 'PENDING', 'c')`,
    ).catch((e) => e as AppError)
    expect((err as AppError).code).toBe('UNPROCESSABLE')
  })

  it('maps a foreign-key violation to CONFLICT', async () => {
    const err = await query(
      `INSERT INTO run_stage_result (run_id, stage, outcome) VALUES (999999, 's', 'ok')`,
    ).catch((e) => e as AppError)
    expect((err as AppError).code).toBe('CONFLICT')
  })

  it('leaves an unrecognised database error untranslated rather than mislabelling it', async () => {
    const err = await query('SELECT * FROM table_that_does_not_exist').catch((e) => e as Error)
    expect(err).not.toBeInstanceOf(AppError)
  })
})

describe('query helpers', () => {
  it('queryOne returns null rather than throwing when nothing matched', async () => {
    expect(await queryOne('SELECT * FROM tx_probe WHERE id = 12345')).toBeNull()
  })

  it('binds parameters rather than interpolating them (P8.5)', async () => {
    const hostile = "1); DROP TABLE tx_probe; --"
    const res = await query('SELECT * FROM tx_probe WHERE note = $1', [hostile])
    expect(res.rowCount).toBe(0)
    // The table still exists: the value was data, never SQL.
    expect((await query('SELECT * FROM tx_probe')).rowCount).toBe(0)
  })

  it('reports rowCount for a write', async () => {
    const res = await query('INSERT INTO tx_probe (id) VALUES (1), (2)')
    expect(res.rowCount).toBe(2)
  })
})
