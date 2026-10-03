/**
 * Governance route contract tests: audit querying and user administration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort, writeAudit } from '../../src/modules/governance/services/auditService.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let admin: TestUser
let organiser: TestUser

beforeAll(async () => {
  await resetDatabase()
  installAuditPort()
  admin = await makeUser('admin')
  organiser = await makeUser('organiser')

  await withCorrelation({ correlationId: 'route-test' }, async () => {
    await writeAudit({ actor: 'a@x', action: 'rubric.frozen', subjectType: 'rubric', subjectId: 'rb_1', payload: { version: 2 } })
    await writeAudit({ actor: 'b@x', action: 'run.started', subjectType: 'run', subjectId: '1' })
    await writeAudit({ actor: 'a@x', action: 'run.started', subjectType: 'run', subjectId: '2' })
  })
})

afterAll(async () => closeApp())

describe('audit endpoint (E09-S01)', () => {
  it('lists events with a real backend total', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/governance/audit?pageSize=2', headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: unknown[]; meta: { total: number } }
    expect(body.data).toHaveLength(2)
    expect(body.meta.total).toBeGreaterThanOrEqual(3)
  })

  it('filters by actor', async () => {
    const app = await getApp()
    const body = (await app.inject({
      method: 'GET', url: '/api/v1/governance/audit?actor=a@x', headers: authHeader(organiser),
    })).json() as { data: Array<{ actor: string }>; meta: { total: number } }
    expect(body.meta.total).toBe(2)
    expect(body.data.every((e) => e.actor === 'a@x')).toBe(true)
  })

  it('filters by action', async () => {
    const app = await getApp()
    const body = (await app.inject({
      method: 'GET', url: '/api/v1/governance/audit?action=run.started', headers: authHeader(organiser),
    })).json() as { meta: { total: number } }
    expect(body.meta.total).toBe(2)
  })

  it('filters by subject type and id', async () => {
    const app = await getApp()
    const body = (await app.inject({
      method: 'GET', url: '/api/v1/governance/audit?subjectType=rubric&subjectId=rb_1',
      headers: authHeader(organiser),
    })).json() as { data: Array<{ payload: unknown }>; meta: { total: number } }
    expect(body.meta.total).toBe(1)
    expect(body.data[0]?.payload).toEqual({ version: 2 })
  })

  it('offers no write path — the trail is append-only (P7.1)', async () => {
    const app = await getApp()
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'] as const) {
      const res = await app.inject({
        method, url: '/api/v1/governance/audit', headers: authHeader(admin), payload: {},
      })
      expect(res.statusCode, method).toBe(404)
    }
  })
})

describe('user administration (E09-S03)', () => {
  it('an admin can list users, with a real total', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/governance/users', headers: authHeader(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: unknown[]; meta: { total: number } }
    expect(body.meta.total).toBeGreaterThanOrEqual(2)
  })

  it('an admin can create a user, returning 201', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/governance/users', headers: authHeader(admin),
      payload: {
        email: 'created@test.local', displayName: 'Created',
        password: 'a-sufficiently-long-password', role: 'reviewer',
      },
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as { data: { role: string } }).data.role).toBe('reviewer')
  })

  it('never echoes the password back', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/governance/users', headers: authHeader(admin),
      payload: {
        email: 'echo@test.local', displayName: 'Echo',
        password: 'must-not-be-echoed-back', role: 'viewer',
      },
    })
    expect(res.body).not.toContain('must-not-be-echoed-back')
  })

  it('rejects an invalid role rather than defaulting to one', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/governance/users', headers: authHeader(admin),
      payload: {
        email: 'role@test.local', displayName: 'R',
        password: 'a-sufficiently-long-password', role: 'superuser',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('denies an organiser user administration (admin only)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/governance/users', headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('error handling (P6.2)', () => {
  it('rejects a body that is not valid JSON', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error')
  })

  it('rejects an oversized payload with PAYLOAD_TOO_LARGE', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(6 * 1024 * 1024) }),
    })
    expect(res.statusCode).toBe(413)
    expect((res.json() as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('does not describe internal failures to the caller (P8.3)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/runs/99999999', headers: authHeader(admin),
    })
    expect(res.body).not.toMatch(/at Module|node_modules|\.ts:\d+/)
  })
})
