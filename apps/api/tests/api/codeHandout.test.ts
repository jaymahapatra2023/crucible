/**
 * The code handout endpoint: organiser-only, dry run by default, re-send only when asked.
 *
 * `resend` exists because the first real handout at the event reached one person per team. It is
 * the control that puts that right, which also makes it the control that could re-mail a
 * credential to a hundred people by accident — so what is pinned here is that it defaults to
 * off, that it is refused below organiser, and that the dry run stays a dry run either way.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { resetRateLimit } from '../../src/http/rateLimit.js'

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetRateLimit()
  app = await getApp()
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
})

afterAll(async () => { await closeApp() })

const handOut = (user: TestUser, payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url: '/api/v1/submissions/codes/hand-out',
  headers: authHeader(user), payload,
})

describe('POST /submissions/codes/hand-out', () => {
  it('reports the plan to an organiser and sends nothing by default', async () => {
    const res = await handOut(organiser)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { summary: Record<string, number>; report: unknown } }>()
    expect(body.data.summary).toMatchObject({ total: 0, waiting: 0 })
    // `confirm` defaults to false, so the default call is a dry run even with an empty payload.
    expect(body.data.report).toBeNull()
  })

  it('REFUSES a reviewer — a handout spends a credential, not just a page view', async () => {
    const res = await handOut(reviewer, { confirm: true })
    expect(res.statusCode).toBe(403)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/submissions/codes/hand-out', payload: { confirm: true },
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts resend explicitly, and still sends nothing while confirm is false', async () => {
    const res = await handOut(organiser, { confirm: false, resend: true })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { report: unknown } }>().data.report).toBeNull()
  })

  it('rejects a non-boolean resend rather than coercing it to a send', async () => {
    const res = await handOut(organiser, { confirm: true, resend: 'yes' })
    expect(res.statusCode).toBe(400)
  })
})
