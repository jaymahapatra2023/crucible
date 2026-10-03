/**
 * API contract tests (P6.1–P6.5).
 *
 * These assert the shape of the API, which is the thing other teams and the web app compile
 * against. A breaking change here is a breaking change for every consumer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { openRun } from '../../src/modules/platform/services/runLedgerService.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import { query } from '../../src/db/pool.js'

let admin: TestUser
let reviewer: TestUser
let viewer: TestUser

beforeAll(async () => {
  await resetDatabase()
  installAuditPort()
  admin = await makeUser('admin')
  reviewer = await makeUser('reviewer')
  viewer = await makeUser('viewer')
})

afterAll(async () => closeApp())

describe('P6.2 — response envelope', () => {
  it('wraps success in { data }', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(admin) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('data')
    expect(body).not.toHaveProperty('error')
  })

  it('wraps failure in { error: { code, message } } with a correct status', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/runs/999999', headers: authHeader(admin),
    })
    expect(res.statusCode).toBe(404)
    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toMatch(/not found/i)
  })

  it('never returns 200 with a failure payload', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(res.statusCode).not.toBe(200)
    expect(res.json()).toHaveProperty('error')
  })

  it('returns 404 in the envelope for an unknown route, once authenticated', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/does-not-exist', headers: authHeader(admin),
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('answers an unknown protected route with 401, not 404, before authentication', () => {
    // Deliberate: 404-before-auth would let an anonymous caller enumerate which endpoints
    // exist. Authentication is checked first, so existence is not disclosed (P8.5).
    return getApp().then(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/secret-admin-tool' })
      expect(res.statusCode).toBe(401)
    })
  })
})

describe('P6.3 — pagination', () => {
  beforeAll(async () => {
    for (let i = 0; i < 7; i++) {
      await withCorrelation({ correlationId: `seed-${i}` }, () => openRun({ kind: 'SCAN' }))
    }
  })

  it('returns a real backend total, not the page length (P5.7)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/runs?page=1&pageSize=3', headers: authHeader(viewer),
    })
    const body = res.json() as { data: unknown[]; meta: { total: number; truncated: boolean } }
    expect(body.data).toHaveLength(3)
    expect(body.meta.total).toBe(7)
    expect(body.meta.truncated).toBe(true)
  })

  it('applies the default page size when none is given', async () => {
    const app = await getApp()
    const body = (await app.inject({
      method: 'GET', url: '/api/v1/platform/runs', headers: authHeader(viewer),
    })).json() as { meta: { pageSize: number } }
    expect(body.meta.pageSize).toBe(20)
  })

  it('rejects a page size above the maximum rather than silently clamping', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/runs?pageSize=1000', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
  })

  it('marks the last page as not truncated', async () => {
    const app = await getApp()
    const body = (await app.inject({
      method: 'GET', url: '/api/v1/platform/runs?page=1&pageSize=100', headers: authHeader(viewer),
    })).json() as { meta: { truncated: boolean } }
    expect(body.meta.truncated).toBe(false)
  })
})

describe('P6.5 — boundary validation', () => {
  it('rejects a malformed body with per-field detail', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { email: 'not-an-email' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string; details: { issues: Array<{ path: string }> } } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.issues.map((i) => i.path)).toContain('email')
  })

  it('rejects a non-numeric path parameter', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/runs/abc', headers: authHeader(admin),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('P8.1 / E09-S03 — role enforcement', () => {
  it('permits a viewer to read runs', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/runs', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
  })

  it('denies a reviewer the audit log (organiser and above)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/governance/audit', headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('denies a reviewer a config write (admin only)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/platform/config/llm.concurrency',
      headers: authHeader(reviewer), payload: { value: 99 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('permits an admin the same config write', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/platform/config/llm.concurrency',
      headers: authHeader(admin), payload: { value: 6 },
    })
    expect(res.statusCode).toBe(200)
  })

  it('audits every denial (E09-S03 acceptance 3)', async () => {
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event WHERE action = 'authorization.denied'`)
    expect(rows.rows[0]!.n).toBeGreaterThanOrEqual(2)
  })

  it('states the required role in the denial message, not just a code', async () => {
    const app = await getApp()
    const body = (await app.inject({
      method: 'GET', url: '/api/v1/governance/audit', headers: authHeader(reviewer),
    })).json() as { error: { message: string } }
    expect(body.error.message).toMatch(/requires the 'organiser' role/)
  })
})

describe('P9.2 — correlation', () => {
  it('returns an X-Request-ID on every response', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers['x-request-id']).toBeTruthy()
  })

  it('propagates a caller-supplied request id', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/health', headers: { 'x-request-id': 'caller-supplied-id' },
    })
    expect(res.headers['x-request-id']).toBe('caller-supplied-id')
  })
})

describe('P8.3 — secrets never surface', () => {
  it('does not leak the token or password back in any response', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: admin.email, password: 'test-password-long-enough' },
    })
    expect(res.body).not.toContain('test-password-long-enough')
  })

  it('does not reveal whether an account exists', async () => {
    const app = await getApp()
    const unknown = await (await getApp()).inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'nobody@nowhere.test', password: 'whatever-password' },
    })
    const wrongPass = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: admin.email, password: 'wrong-password-here' },
    })
    expect(unknown.statusCode).toBe(401)
    expect(wrongPass.statusCode).toBe(401)
    expect(unknown.json()).toEqual(wrongPass.json())
  })
})
