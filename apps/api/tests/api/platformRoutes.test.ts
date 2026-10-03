/**
 * Platform surface contract tests: health, metrics, config, flags, LLM observability.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, registerTestCallKey, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { query } from '../../src/db/pool.js'

let admin: TestUser
let viewer: TestUser

beforeAll(async () => {
  await resetDatabase()
  installAuditPort()
  invalidateConfig()
  admin = await makeUser('admin')
  viewer = await makeUser('viewer')
})

afterAll(async () => closeApp())

describe('health (P9.4)', () => {
  it('/health is public and carries no data', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { status: 'ok' } })
  })

  it('/ready confirms the database is reachable', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { status: string } }).data.status).toBe('ready')
  })

  it('the detailed health view reports what is degraded, not just a tick', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/health', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    const body = (res.json() as {
      data: { status: string; database: { reachable: boolean; migrations: number }; providers: unknown[] }
    }).data
    expect(body.database.reachable).toBe(true)
    expect(body.database.migrations).toBeGreaterThan(0)
    // No provider key is configured in tests, so health must say DEGRADED rather than HEALTHY.
    expect(body.status).toBe('DEGRADED')
  })

  it('reports the safety ceilings, so a tripped one is seen and not only logged (E41-S01)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/health', headers: authHeader(viewer),
    })
    const body = (res.json() as { data: { ceilings: { enabled: boolean; trips: unknown[] } } }).data
    expect(body.ceilings).toEqual({ enabled: expect.any(Boolean), trips: [] })
  })

  it('the detailed health view requires authentication — it is operational data', async () => {
    const app = await getApp()
    expect((await app.inject({ method: 'GET', url: '/api/v1/platform/health' })).statusCode).toBe(401)
  })
})

describe('metrics (P9.3)', () => {
  it('is public, in Prometheus text format', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('# HELP crucible_runs_total')
    expect(res.body).toContain('# TYPE crucible_llm_calls_total counter')
  })

  it('exposes no submission, team or score data', async () => {
    const app = await getApp()
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body
    expect(body).not.toMatch(/team|submission_id|rationale|excerpt/i)
  })
})

describe('config (P3.6, P7.5)', () => {
  it('lists declared configuration for a module', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/platform/config?module=llm', headers: authHeader(viewer),
    })
    const keys = (res.json() as { data: Array<{ key: string }> }).data.map((r) => r.key)
    expect(keys).toContain('llm.default_model')
    expect(keys).toContain('llm.cost_ceiling_usd_per_run')
    expect(keys).toContain('llm.concurrency')
  })

  it('an admin can change a value, and the change is audited and historised', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/platform/config/llm.max_attempts',
      headers: authHeader(admin), payload: { value: 5 },
    })
    expect(res.statusCode).toBe(200)

    const history = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM app_config_history WHERE key = 'llm.max_attempts'`)
    expect(history.rows[0]!.n).toBeGreaterThan(0)

    const audit = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event WHERE action = 'config.updated'`)
    expect(audit.rows[0]!.n).toBeGreaterThan(0)
  })

  it('rejects an unknown key rather than creating one at runtime (P7.5)', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/platform/config/llm.invented_at_runtime',
      headers: authHeader(admin), payload: { value: 1 },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('feature flags (P12.3)', () => {
  it('lists declared flags', async () => {
    const app = await getApp()
    const keys = ((await app.inject({
      method: 'GET', url: '/api/v1/platform/flags', headers: authHeader(viewer),
    })).json() as { data: Array<{ key: string }> }).data.map((f) => f.key)
    expect(keys).toContain('feature.scoring.double_run')
  })

  it('an admin can toggle a flag', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/platform/flags/feature.probes.network_egress',
      headers: authHeader(admin), payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { enabled: boolean } }).data.enabled).toBe(true)
  })

  it('rejects a flag that is not declared', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/platform/flags/feature.made.up',
      headers: authHeader(admin), payload: { enabled: true },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('LLM observability (P9.3)', () => {
  it('lists the call registry', async () => {
    await registerTestCallKey({ callKey: 'test.observability', userPrompt: 'Go.' })
    const app = await getApp()
    const keys = ((await app.inject({
      method: 'GET', url: '/api/v1/llm/registry', headers: authHeader(viewer),
    })).json() as { data: Array<{ callKey: string }> }).data.map((r) => r.callKey)
    expect(keys).toContain('test.observability')
  })

  it('reports per-call_key metrics over a window', async () => {
    await query(
      `INSERT INTO llm_call_log (call_key, model_used, status, latency_ms, tokens_in, tokens_out, cost_usd, prompt_hash)
       VALUES ('test.observability','claude-sonnet-5','OK',120,100,50,0.001,repeat('a',64)),
              ('test.observability','claude-sonnet-5','TIMEOUT',9000,0,0,0,repeat('b',64))`)
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/llm/metrics?sinceHours=24', headers: authHeader(viewer),
    })
    const row = (res.json() as {
      data: Array<{ callKey: string; calls: number; errorRate: number; p99LatencyMs: number }>
    }).data.find((r) => r.callKey === 'test.observability')
    expect(row?.calls).toBe(2)
    expect(row?.errorRate).toBeCloseTo(0.5, 5)
    expect(row?.p99LatencyMs).toBeGreaterThan(0)
  })

  it('reports provider availability', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET', url: '/api/v1/llm/providers', headers: authHeader(viewer),
    })
    expect(Array.isArray((res.json() as { data: unknown[] }).data)).toBe(true)
  })

  it('offers no ad-hoc prompt endpoint — every call has a registered key (P3.1/P3.2)', async () => {
    const app = await getApp()
    for (const url of ['/api/v1/llm/complete', '/api/v1/llm/prompt', '/api/v1/llm/call']) {
      const res = await app.inject({ method: 'POST', url, headers: authHeader(admin), payload: {} })
      expect(res.statusCode, url).toBe(404)
    }
  })
})

describe('system readiness (plan §IV.5)', () => {
  it('reports every statement of the definition of done', async () => {
    const res = await (await getApp()).inject({
      method: 'GET', url: '/api/v1/platform/readiness/any-cohort',
      headers: authHeader(viewer),
    })

    expect(res.statusCode).toBe(200)
    const { data } = res.json() as {
      data: { ready: boolean; checks: Array<{ id: string; statement: string; status: string }> }
    }
    // Asserted by CONTENT: a hard-coded total breaks whenever a check is added and says
    // nothing about whether the right ones are present.
    expect(data.checks.map((c) => c.id)).toEqual(expect.arrayContaining([
      'rubric_frozen', 'submission_evidence', 'two_runs', 'ranking',
      'calibration', 'cut_band', 'appeal_packet',
    ]))
    expect(data.ready).toBe(false)
  })

  it('is readable by any signed-in user — fitness to decide is not privileged', async () => {
    const res = await (await getApp()).inject({
      method: 'GET', url: '/api/v1/platform/readiness/x', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await (await getApp()).inject({
      method: 'GET', url: '/api/v1/platform/readiness/x',
    })
    expect(res.statusCode).toBe(401)
  })
})

