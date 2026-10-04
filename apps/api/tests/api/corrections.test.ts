/**
 * The public confirm endpoint at the HTTP edge (migration 104).
 *
 * The thing that matters here is the boundary: anonymous may POST a claim and nothing else, and
 * the reply carries no fact about the roster. The queue and the decision are organiser-only.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'api' }, fn)

afterAll(async () => closeApp())

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  app = await getApp()
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
  await inScope(() => importRoster({
    kind: 'participant', csv: 'full_name,email\nAda Lovelace,old@example.test',
    confirm: true, actor: 'o@test.local',
  }))
})

const claim = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/confirm', payload })

describe('the public endpoint', () => {
  it('takes a claim with no credential at all', async () => {
    const res = await claim({ fullName: 'Ada Lovelace', email: 'new@example.test' })
    expect(res.statusCode).toBe(200)
  })

  it('says the same thing for a name on the list and one that is not', async () => {
    const hit = await claim({ fullName: 'Ada Lovelace', email: 'new@example.test' })
    const miss = await claim({ fullName: 'Nobody Here', email: 'nobody@example.test' })
    expect(hit.json()).toEqual(miss.json())
  })

  it('returns nothing about the roster — no id, no name, no address', async () => {
    const res = await claim({ fullName: 'Ada Lovelace', email: 'new@example.test' })
    expect(res.body).not.toMatch(/old@example.test/)
    expect(res.body).not.toMatch(/participantId/)
    expect(res.body).not.toMatch(/Lovelace/)
  })

  it('refuses a malformed claim rather than recording it', async () => {
    expect((await claim({ fullName: 'A', email: 'new@example.test' })).statusCode).toBe(400)
    expect((await claim({ fullName: 'Ada Lovelace', email: 'not-an-email' })).statusCode).toBe(400)
  })
})

describe('the queue is staff only', () => {
  it('refuses the queue without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster/corrections' })
    expect(res.statusCode).toBe(401)
  })

  it('refuses the queue to a reviewer', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/corrections',
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('shows an organiser what is waiting, with what would change', async () => {
    await claim({ fullName: 'Ada Lovelace', email: 'new@example.test' })
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/corrections?status=PENDING',
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(200)
    const rows = (res.json() as { data: Array<Record<string, unknown>> }).data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      claimedEmail: 'new@example.test', currentEmail: 'old@example.test', kind: 'CORRECTION',
    })
  })

  it('refuses a decision from a reviewer', async () => {
    await claim({ fullName: 'Ada Lovelace', email: 'new@example.test' })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/roster/corrections/1',
      headers: authHeader(reviewer),
      payload: { approve: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it('applies a decision for an organiser', async () => {
    await claim({ fullName: 'Ada Lovelace', email: 'new@example.test' })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/roster/corrections/1',
      headers: authHeader(organiser),
      payload: { approve: true },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { effect: string } }).data.effect).toBe('CORRECTED')
  })
})
