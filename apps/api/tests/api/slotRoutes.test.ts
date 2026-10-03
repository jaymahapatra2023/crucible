/**
 * The slot endpoints (migration 095).
 *
 * Provisioning the floor plan writes teams, so it is an organiser's act; reading where the pool
 * stands is something any signed-in person may need on the day.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let app: FastifyInstance
let organiser: TestUser
let viewer: TestUser

const SLOTS = ['label,room,coach', 'Team 1,Hall A,Margaret Hamilton', 'Team 2,Hall A,Margaret Hamilton'].join('\n')

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  app = await getApp()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')
  await withCorrelation({ correlationId: 'slots' }, async () => {
    await importRoster({
      kind: 'room', csv: 'label,location,capacity\nHall A,First floor,40',
      confirm: true, actor: 'seed',
    })
    await importRoster({
      kind: 'coach', csv: 'name,email\nMargaret Hamilton,margaret@example.test',
      confirm: true, actor: 'seed',
    })
  })
})

afterAll(async () => { await closeApp() })

describe('provisioning', () => {
  it('plans without writing, then provisions on confirm', async () => {
    const dry = await app.inject({
      method: 'POST', url: '/api/v1/roster/slots', headers: authHeader(organiser),
      payload: { csv: SLOTS, confirm: false },
    })
    expect(dry.statusCode).toBe(200)
    expect(dry.json<{ data: { provisioned: boolean; summary: { new: number } } }>().data)
      .toMatchObject({ provisioned: false, summary: expect.objectContaining({ new: 2 }) })

    const wet = await app.inject({
      method: 'POST', url: '/api/v1/roster/slots', headers: authHeader(organiser),
      payload: { csv: SLOTS, confirm: true },
    })
    expect(wet.json<{ data: { provisioned: boolean } }>().data.provisioned).toBe(true)
  })

  it('is not a viewer act — it creates teams', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/roster/slots', headers: authHeader(viewer),
      payload: { csv: SLOTS, confirm: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a signed-out caller', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/roster/slots', payload: { csv: SLOTS, confirm: true },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a body with no file rather than provisioning nothing silently', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/roster/slots', headers: authHeader(organiser),
      payload: { confirm: true },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('reading the pool', () => {
  it('is readable by anyone signed in, because on the day everyone needs it', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/roster/slots', headers: authHeader(organiser),
      payload: { csv: SLOTS, confirm: true },
    })

    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/slots', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    const data = res.json<{
      data: { status: { total: number; available: number }; slots: Array<{ slot_label: string }> }
    }>().data
    expect(data.status).toMatchObject({ total: 2, available: 2, claimed: 0 })
    expect(data.slots.map((s) => s.slot_label)).toEqual(['Team 1', 'Team 2'])
  })

  it('reports an empty pool as empty, not as an error', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/slots', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { status: { total: number } } }>().data.status.total).toBe(0)
  })

  it('refuses a signed-out caller', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/roster/slots' })).statusCode).toBe(401)
  })
})
