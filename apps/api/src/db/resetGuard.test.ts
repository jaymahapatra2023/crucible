import { describe, expect, it } from 'vitest'
import { checkResetAllowed } from './resetGuard.js'

describe('db:reset guard (E01-S02 acceptance 4)', () => {
  it('allows a local development database, with confirmation required', () => {
    const r = checkResetAllowed('postgresql://localhost:5432/crucible', 'development')
    expect(r.allowed).toBe(true)
    expect(r.requiresConfirmation).toBe(true)
  })

  it('allows a local test database without confirmation, so harnesses can reset it', () => {
    const r = checkResetAllowed('postgresql://127.0.0.1:5432/crucible_test', 'test')
    expect(r.allowed).toBe(true)
    expect(r.requiresConfirmation).toBe(false)
  })

  it('REFUSES a remote host', () => {
    const r = checkResetAllowed('postgresql://db.production.example.com:5432/crucible', 'development')
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/loopback/)
  })

  it('REFUSES production regardless of host', () => {
    const r = checkResetAllowed('postgresql://localhost:5432/crucible', 'production')
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/production/)
  })

  it('REFUSES an unparseable connection string rather than guessing', () => {
    expect(checkResetAllowed('not-a-url', 'development').allowed).toBe(false)
  })

  it('REFUSES a database whose name is not recognisably disposable', () => {
    const r = checkResetAllowed('postgresql://localhost:5432/customer_data', 'development')
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/not recognisably/)
  })

  it('still requires confirmation for the dev database even when NODE_ENV is test', () => {
    // The dangerous case: a test runner sets NODE_ENV=test while DATABASE_URL still points at
    // the developer's working database. Confirmation must not be waived.
    const r = checkResetAllowed('postgresql://localhost:5432/crucible', 'test')
    expect(r.allowed).toBe(true)
    expect(r.requiresConfirmation).toBe(true)
  })
})
