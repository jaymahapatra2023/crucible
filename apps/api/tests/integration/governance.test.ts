/**
 * Governance integration tests (E09-S01, E09-S03, P7.1).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { auditTrailFor, installAuditPort, listAudit, writeAudit } from '../../src/modules/governance/services/auditService.js'
import { createUser, getUsers, signIn } from '../../src/modules/governance/services/identityService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
})

const inScope = <T>(fn: () => Promise<T>) =>
  withCorrelation({ correlationId: 'gov-test-correlation' }, fn)

describe('audit trail (E09-S01)', () => {
  it('records actor, action, subject and payload', async () => {
    await inScope(() => writeAudit({
      actor: 'org@test.local', action: 'rubric.frozen',
      subjectType: 'rubric', subjectId: 'rb_1', payload: { version: 3 },
    }))
    const { events, total } = await listAudit({}, 10, 0)
    expect(total).toBe(1)
    expect(events[0]).toMatchObject({
      actor: 'org@test.local', action: 'rubric.frozen',
      subjectType: 'rubric', subjectId: 'rb_1', payload: { version: 3 },
    })
  })

  it('stamps the correlation id from the ambient scope (P9.2)', async () => {
    await inScope(() => writeAudit({
      actor: 'a', action: 'x.y', subjectType: 't', subjectId: '1',
    }))
    const { events } = await listAudit({}, 10, 0)
    expect(events[0]?.correlationId).toBe('gov-test-correlation')
  })

  it('is append-only at the DATABASE level, not merely by convention (P7.1, P8.5)', async () => {
    await inScope(() => writeAudit({ actor: 'a', action: 'x.y', subjectType: 't', subjectId: '1' }))
    await expect(query(`UPDATE audit_event SET actor = 'tampered'`)).rejects.toThrow(/append-only/)
    await expect(query('DELETE FROM audit_event')).rejects.toThrow(/append-only/)
  })

  it('filters by subject, actor and action, each with a real total (P5.7)', async () => {
    await inScope(async () => {
      await writeAudit({ actor: 'a@x', action: 'run.started', subjectType: 'run', subjectId: '1' })
      await writeAudit({ actor: 'b@x', action: 'run.started', subjectType: 'run', subjectId: '2' })
      await writeAudit({ actor: 'a@x', action: 'rubric.frozen', subjectType: 'rubric', subjectId: '9' })
    })
    expect((await listAudit({ actor: 'a@x' }, 10, 0)).total).toBe(2)
    expect((await listAudit({ action: 'run.started' }, 10, 0)).total).toBe(2)
    expect((await listAudit({ subjectType: 'rubric' }, 10, 0)).total).toBe(1)
    expect((await listAudit({ subjectType: 'run', subjectId: '2' }, 10, 0)).total).toBe(1)
  })

  it('returns one subject trail oldest-first, as the appeal packet needs (E09-S02)', async () => {
    await inScope(async () => {
      await writeAudit({ actor: 'a', action: 'submission.created', subjectType: 'submission', subjectId: 's1' })
      await writeAudit({ actor: 'a', action: 'submission.validated', subjectType: 'submission', subjectId: 's1' })
      await writeAudit({ actor: 'a', action: 'other.event', subjectType: 'run', subjectId: 'r1' })
    })
    const trail = await auditTrailFor('submission', 's1')
    expect(trail.map((e) => e.action)).toEqual(['submission.created', 'submission.validated'])
  })

  it('paginates with a real backend total', async () => {
    await inScope(async () => {
      for (let i = 0; i < 5; i++) {
        await writeAudit({ actor: 'a', action: 'x.y', subjectType: 't', subjectId: String(i) })
      }
    })
    const { events, total } = await listAudit({}, 2, 0)
    expect(events).toHaveLength(2)
    expect(total).toBe(5)
  })
})

describe('identity (E09-S03, P8.1)', () => {
  it('creates a user and signs them in', async () => {
    await inScope(() => createUser({
      email: 'new@test.local', displayName: 'New Person',
      password: 'a-sufficiently-long-password', role: 'organiser', actor: 'admin@test.local',
    }))
    const result = await inScope(() => signIn('new@test.local', 'a-sufficiently-long-password'))
    expect(result.user.role).toBe('organiser')
    expect(result.token.split('.')).toHaveLength(3)
  })

  it('never stores the password in plaintext (P8.3)', async () => {
    await inScope(() => createUser({
      email: 'hash@test.local', displayName: 'H',
      password: 'plaintext-never-stored-here', role: 'viewer', actor: 'admin',
    }))
    const row = await query<{ password_hash: string }>(
      `SELECT password_hash FROM crucible_user WHERE email = 'hash@test.local'`)
    expect(row.rows[0]!.password_hash).not.toContain('plaintext-never-stored-here')
    expect(row.rows[0]!.password_hash).toMatch(/^scrypt\$/)
  })

  it('rejects a short password', async () => {
    await expect(inScope(() => createUser({
      email: 'short@test.local', displayName: 'S', password: 'short', role: 'viewer', actor: 'a',
    }))).rejects.toThrow(/at least 12 characters/)
  })

  it('gives an identical response for unknown user and wrong password', async () => {
    await inScope(() => createUser({
      email: 'known@test.local', displayName: 'K',
      password: 'a-sufficiently-long-password', role: 'viewer', actor: 'a',
    }))
    const unknown = await inScope(() => signIn('nobody@test.local', 'whatever-password')).catch((e) => e as Error)
    const wrong = await inScope(() => signIn('known@test.local', 'wrong-password-here')).catch((e) => e as Error)
    expect(unknown.message).toBe(wrong.message)
  })

  it('refuses an inactive account', async () => {
    await inScope(() => createUser({
      email: 'inactive@test.local', displayName: 'I',
      password: 'a-sufficiently-long-password', role: 'viewer', actor: 'a',
    }))
    await query(`UPDATE crucible_user SET active = FALSE WHERE email = 'inactive@test.local'`)
    await expect(
      inScope(() => signIn('inactive@test.local', 'a-sufficiently-long-password')),
    ).rejects.toThrow(/not recognised/)
  })

  it('audits both successful and failed sign-in', async () => {
    await inScope(() => createUser({
      email: 'audited@test.local', displayName: 'A',
      password: 'a-sufficiently-long-password', role: 'viewer', actor: 'a',
    }))
    await inScope(() => signIn('audited@test.local', 'a-sufficiently-long-password'))
    await inScope(() => signIn('audited@test.local', 'nope-wrong-password')).catch(() => undefined)

    const actions = (await listAudit({ subjectType: 'user' }, 50, 0)).events.map((e) => e.action)
    expect(actions).toContain('auth.signed_in')
    const failed = (await listAudit({ action: 'auth.sign_in_failed' }, 50, 0)).total
    expect(failed).toBeGreaterThan(0)
  })

  it('lists users with a real backend total', async () => {
    await inScope(async () => {
      for (let i = 0; i < 3; i++) {
        await createUser({
          email: `u${i}@test.local`, displayName: `U${i}`,
          password: 'a-sufficiently-long-password', role: 'viewer', actor: 'a',
        })
      }
    })
    const { users, total } = await getUsers(2, 0)
    expect(users).toHaveLength(2)
    expect(total).toBe(3)
  })

  it('refuses a duplicate email', async () => {
    const make = () => inScope(() => createUser({
      email: 'dupe@test.local', displayName: 'D',
      password: 'a-sufficiently-long-password', role: 'viewer', actor: 'a',
    }))
    await make()
    await expect(make()).rejects.toThrow()
  })
})
