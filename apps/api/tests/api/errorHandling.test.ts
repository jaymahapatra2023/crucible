/**
 * Error-handler branch tests (P6.2, P8.3).
 *
 * Uses a purpose-built server with routes that throw each error shape, because the production
 * routes — correctly — do not have a way to raise an unhandled exception on demand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z, ZodError } from 'zod'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { buildServer } from '../../src/server.js'
import { AppError } from '../../src/lib/appError.js'
import { makeUser, authHeader, closeApp, type TestUser } from '../support/testServer.js'

let app: FastifyInstance
let admin: TestUser

beforeAll(async () => {
  await resetDatabase()
  admin = await makeUser('admin')

  app = await buildServer({ quiet: true, withoutJobs: true })
  app.get('/api/v1/platform/throws-app-error', async () => {
    throw new AppError('RUBRIC_NOT_FROZEN', 'Scoring cannot start against a draft rubric.', {
      details: { rubricId: 'rb_9' },
    })
  })
  app.get('/api/v1/platform/throws-zod', async () => {
    throw new ZodError(z.object({ n: z.number() }).safeParse({ n: 'x' }).error!.issues)
  })
  app.get('/api/v1/platform/throws-raw', async () => {
    const err = new Error('a secret-bearing internal failure at /Users/someone/secret/path')
    throw err
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await closeApp()
})

describe('AppError responses', () => {
  it('uses the status the code maps to, and carries details', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/throws-app-error', headers: authHeader(admin),
    })
    expect(res.statusCode).toBe(422)
    const body = res.json() as { error: { code: string; message: string; details: unknown } }
    expect(body.error.code).toBe('RUBRIC_NOT_FROZEN')
    expect(body.error.message).toMatch(/draft rubric/)
    expect(body.error.details).toEqual({ rubricId: 'rb_9' })
  })
})

describe('ZodError responses', () => {
  it('becomes a 400 VALIDATION_FAILED listing the offending paths', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/throws-zod', headers: authHeader(admin),
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as {
      error: { code: string; details: { issues: Array<{ path: string; message: string }> } }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.issues.length).toBeGreaterThan(0)
  })
})

describe('unhandled errors', () => {
  it('becomes a 500 INTERNAL_ERROR', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/throws-raw', headers: authHeader(admin),
    })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR')
  })

  it('does not describe the internal failure to the caller (P8.3)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/throws-raw', headers: authHeader(admin),
    })
    expect(res.body).not.toContain('secret-bearing')
    expect(res.body).not.toContain('/Users/someone')
  })

  it('returns the correlation id so a support conversation can find the log line (P9.2)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/throws-raw', headers: authHeader(admin),
    })
    const body = res.json() as { error: { details: { correlationId: string } } }
    expect(body.error.details.correlationId).toBeTruthy()
    expect(res.headers['x-request-id']).toBe(body.error.details.correlationId)
  })
})
