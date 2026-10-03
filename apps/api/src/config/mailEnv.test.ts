/**
 * Choosing a transmitting adapter without its credentials fails at boot, by name (E43, E01-S03).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigurationError, loadEnv, resetEnvCache } from './env.js'

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(40),
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvCache()
})

describe('MAIL_PROVIDER=resend', () => {
  it('refuses to boot without the key AND the sender, naming both with the reason', () => {
    let thrown: unknown
    try { loadEnv({ ...base, MAIL_PROVIDER: 'resend' }) } catch (err) { thrown = err }

    expect(thrown).toBeInstanceOf(ConfigurationError)
    const problems = (thrown as ConfigurationError).problems
    // Both at once — fixing one to be told about the next is a poor use of anyone's evening.
    expect(problems).toHaveLength(2)
    // And WHY, because "is required" without the condition reads as a contradiction of the
    // default that needs nothing.
    expect(problems.join(' ')).toMatch(/MAIL_API_KEY is required when MAIL_PROVIDER is resend/)
    expect(problems.join(' ')).toMatch(/MAIL_FROM is required when MAIL_PROVIDER is resend/)
  })

  it('boots with both present', () => {
    expect(loadEnv({
      ...base, MAIL_PROVIDER: 'resend', MAIL_API_KEY: 're_x', MAIL_FROM: 'a@b.test',
    }).MAIL_PROVIDER).toBe('resend')
  })
})

describe('the default', () => {
  it('needs nothing — record composes rather than sends', () => {
    expect(loadEnv(base).MAIL_PROVIDER).toBe('record')
  })
})
