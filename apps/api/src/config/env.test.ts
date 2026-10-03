import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigurationError, loadEnv, resetEnvCache } from './env.js'

const VALID = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost:5432/crucible_test',
  JWT_SECRET: 'a-secret-that-is-at-least-thirty-two-chars',
} as NodeJS.ProcessEnv

beforeEach(() => resetEnvCache())

describe('loadEnv — fail fast with named errors (E01-S03 acceptance 1)', () => {
  it('accepts a valid environment and applies defaults', () => {
    const env = loadEnv({ ...VALID })
    expect(env.PORT).toBe(3101)
    expect(env.HOST).toBe('127.0.0.1')
    expect(env.LOG_LEVEL).toBe('info')
  })

  it('names every missing variable at once, not just the first', () => {
    try {
      loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError)
      const problems = (err as ConfigurationError).problems
      expect(problems).toHaveLength(2)
      expect(problems.join(' ')).toContain('DATABASE_URL')
      expect(problems.join(' ')).toContain('JWT_SECRET')
    }
  })

  it('distinguishes "not set" from "invalid"', () => {
    try {
      loadEnv({ ...VALID, JWT_SECRET: 'too-short' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as ConfigurationError).problems[0]).toMatch(/JWT_SECRET is invalid/)
    }
  })

  it('rejects a non-postgres connection string with an explanation', () => {
    try {
      loadEnv({ ...VALID, DATABASE_URL: 'mysql://localhost/x' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as ConfigurationError).problems[0]).toMatch(/postgres/)
    }
  })

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv({ ...VALID, PORT: '99999' })).toThrow(ConfigurationError)
  })

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadEnv({ ...VALID, NODE_ENV: 'staging' })).toThrow(ConfigurationError)
  })

  it('never includes a secret value in the error message (P8.3)', () => {
    try {
      loadEnv({ ...VALID, JWT_SECRET: 'short', DATABASE_URL: 'nope' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).not.toContain('short')
    }
  })

  it('treats the provider key as optional so the API boots without it', () => {
    expect(() => loadEnv({ ...VALID })).not.toThrow()
  })
})
