/**
 * Role enforcement (E09-S03).
 *
 * Acceptance 2 names four acts that must be restricted to `organiser` and above: approve,
 * freeze, override and finalise. Those are the acts that determine who presents, so this file
 * asserts them against the running server rather than trusting that a `requireRole` call is
 * still where it was.
 *
 * The matrix is written out per route because a loop over "all routes" would drift into testing
 * the route table instead of the rule. These five are the ones the plan singles out.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { query } from '../../src/db/pool.js'

let app: FastifyInstance
let users: Record<'admin' | 'organiser' | 'reviewer' | 'viewer', TestUser>

/** The privileged acts (acceptance 2), with a body that would otherwise be valid. */
const PRIVILEGED = [
  { name: 'approve a rubric', method: 'POST' as const, url: '/api/v1/rubrics/1/approve', payload: {} },
  { name: 'freeze a rubric', method: 'POST' as const, url: '/api/v1/rubrics/1/freeze', payload: {} },
  { name: 'publish a rubric', method: 'POST' as const, url: '/api/v1/rubrics/1/publish', payload: {} },
  { name: 'finalise a shortlist', method: 'POST' as const, url: '/api/v1/review/runs/1/finalise', payload: {} },
]

/**
 * Acts a REVIEWER may take, and a viewer may not (E23).
 *
 * Deciding about one team moved here from the list above. It was organiser-and-above on the
 * reasoning that reading the evidence and deciding who presents are different acts — but the
 * people who read the evidence ARE the committee, and requiring an organiser to transcribe
 * their conclusion puts a person between the judgement and the record of it.
 *
 * Finalising the shortlist stayed above: deciding about one team and closing the whole list are
 * the acts that genuinely differ.
 */
const REVIEWER_ACTS = [
  {
    name: 'move a team between shortlist, hold and exclude', method: 'POST' as const,
    url: '/api/v1/review/runs/1/decisions',
    payload: { submissionId: 1, decision: 'SHORTLIST', reason: 'A reason long enough to pass.' },
  },
]

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  app = await getApp()
  users = {
    admin: await makeUser('admin'),
    organiser: await makeUser('organiser'),
    reviewer: await makeUser('reviewer'),
    viewer: await makeUser('viewer'),
  }
})

afterAll(async () => {
  await closeApp()
})

describe('the four roles exist (acceptance 1)', () => {
  it('accepts exactly admin, organiser, reviewer and viewer', async () => {
    const roles = await query<{ role: string }>('SELECT DISTINCT role FROM crucible_user')
    expect(roles.rows.map((r) => r.role).sort())
      .toEqual(['admin', 'organiser', 'reviewer', 'viewer'])
  })

  it('refuses a role outside the four', async () => {
    await expect(query(
      `INSERT INTO crucible_user (email, display_name, password_hash, role)
       VALUES ('x@test.local', 'X', 'x', 'superuser')`,
    )).rejects.toThrow()
  })
})

describe('deciding about one team is reviewer and above (E23)', () => {
  for (const act of REVIEWER_ACTS) {
    it(`refuses a VIEWER trying to ${act.name}`, async () => {
      const res = await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.viewer), payload: act.payload,
      })
      expect(res.statusCode).toBe(403)
    })

    it(`lets a REVIEWER past the role check for "${act.name}"`, async () => {
      const res = await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.reviewer), payload: act.payload,
      })
      // Past the gate: it still fails because run 1 has no shortlist, which is a different
      // answer from being refused the act.
      expect(res.statusCode).not.toBe(403)
    })

    it(`lets an ORGANISER past it too`, async () => {
      const res = await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.organiser), payload: act.payload,
      })
      expect(res.statusCode).not.toBe(403)
    })
  }
})

describe('approve, freeze, publish and finalise are organiser and above (acceptance 2)', () => {
  for (const act of PRIVILEGED) {
    it(`refuses a VIEWER trying to ${act.name}`, async () => {
      const res = await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.viewer), payload: act.payload,
      })
      expect(res.statusCode).toBe(403)
    })

    it(`refuses a REVIEWER trying to ${act.name}`, async () => {
      const res = await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.reviewer), payload: act.payload,
      })
      expect(res.statusCode).toBe(403)
    })

    it(`lets an ORGANISER past the role check for "${act.name}"`, async () => {
      const res = await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.organiser), payload: act.payload,
      })
      // Past the gate: it may still fail because rubric 1 does not exist, which is a different
      // answer from being refused the act.
      expect(res.statusCode).not.toBe(403)
    })

    it(`lets an ADMIN past the role check for "${act.name}"`, async () => {
      const res = await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.admin), payload: act.payload,
      })
      expect(res.statusCode).not.toBe(403)
    })
  }
})

describe('denials (acceptance 3)', () => {
  it('say what was needed, not just "forbidden"', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rubrics/1/approve',
      headers: authHeader(users.reviewer), payload: {},
    })

    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/organiser/)
    expect(body.error.message.length).toBeGreaterThan(30)
  })

  it('are AUDITED, with the actor and what they attempted', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/review/runs/1/finalise',
      headers: authHeader(users.reviewer), payload: {},
    })

    const audit = await query<{ actor: string; payload: Record<string, unknown> }>(
      `SELECT actor, payload FROM audit_event WHERE action = 'authorization.denied'`)

    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.actor).toBe(users.reviewer.email)
    expect(JSON.stringify(audit.rows[0]?.payload)).toMatch(/organiser|finalise/)
  })

  it('audit each denial separately rather than collapsing them', async () => {
    for (const act of PRIVILEGED.slice(0, 3)) {
      await app.inject({
        method: act.method, url: act.url,
        headers: authHeader(users.viewer), payload: act.payload,
      })
    }

    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'authorization.denied'`)
    expect(audit.rows).toHaveLength(3)
  })
})

describe('the appeal packet is organiser-only (E09-S02)', () => {
  it('refuses a reviewer — it contains another team’s full evaluation', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/governance/runs/1/appeal/1',
      headers: authHeader(users.reviewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses the audit log to a reviewer', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/governance/audit', headers: authHeader(users.reviewer),
    })
    expect(res.statusCode).toBe(403)
  })
})
