/**
 * Issuing a token for every team that has none (E29-S01).
 *
 * Once the roster has built the teams there is no file to assemble, and exporting forty names in
 * order to re-import them would be work the tool invented rather than work the job requires.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { issueForTeamsWithout } from '../../src/modules/submissions/services/bulkTokens.js'
import {
  issueSubmissionToken, revokeSubmissionToken, verifySubmissionToken,
} from '../../src/modules/submissions/services/submissionTokens.js'
import { createTeam, getTeams } from '../../src/modules/submissions/services/teamService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'for-teams' }, fn)

const run = (confirm: boolean) => inScope(() => issueForTeamsWithout({ confirm, actor: ACTOR }))

const team = (name: string) => inScope(() => createTeam({
  displayName: name, contactEmail: `${name.toLowerCase().replace(/ /g, '-')}@team.test`,
  origin: 'ORGANISER', actor: ACTOR,
}))

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
})

describe('the plan', () => {
  it('lists every team, and which would get a token', async () => {
    await team('Night Shift')
    await team('Daylight')

    const plan = await run(false)
    expect(plan.summary).toMatchObject({ total: 2, new: 2, existing: 0 })
    expect(plan.rows.map((r) => r.teamName).sort()).toEqual(['Daylight', 'Night Shift'])
  })

  it('writes nothing until confirmed', async () => {
    await team('Night Shift')
    await run(false)

    const tokens = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM access_token')
    expect(tokens.rows[0]!.n).toBe(0)
  })

  it('says a team already holding one would NOT be reissued, and why', async () => {
    // Two live tokens per team is two answers to "who submitted this", and a second would not
    // make the first stop working.
    const existing = await team('Night Shift')
    await inScope(() => issueSubmissionToken({
      label: 'Night Shift', teamId: existing.teamId, issuedBy: ACTOR,
    }))

    const plan = await run(false)
    expect(plan.rows[0]!.outcome).toBe('EXISTING')
    expect(plan.rows[0]!.detail).toMatch(/Revoke one before reissuing/)
  })
})

describe('issuing', () => {
  it('gives every team without one a working token', async () => {
    await team('Night Shift')
    await team('Daylight')

    const plan = await run(true)
    expect(plan.issued).toBe(true)
    for (const row of plan.rows) {
      const identity = await verifySubmissionToken(row.token!)
      expect(identity.teamId).toBe(row.teamId)
    }
  })

  it('leaves a team that already holds one untouched', async () => {
    const held = await team('Night Shift')
    const first = await inScope(() => issueSubmissionToken({
      label: 'Night Shift', teamId: held.teamId, issuedBy: ACTOR,
    }))
    await team('Daylight')

    const plan = await run(true)
    expect(plan.rows.filter((r) => r.token !== null)).toHaveLength(1)
    // The one they already had still works.
    expect((await verifySubmissionToken(first.token)).teamId).toBe(held.teamId)
  })

  it('issues again for a team whose only token was REVOKED', async () => {
    const held = await team('Night Shift')
    const first = await inScope(() => issueSubmissionToken({
      label: 'Night Shift', teamId: held.teamId, issuedBy: ACTOR,
    }))
    await inScope(() => revokeSubmissionToken(first.tokenId, ACTOR))

    const plan = await run(true)
    expect(plan.rows[0]!.outcome).toBe('NEW')
    expect((await verifySubmissionToken(plan.rows[0]!.token!)).teamId).toBe(held.teamId)
  })

  it('says so plainly when every team already holds one', async () => {
    const held = await team('Night Shift')
    await inScope(() => issueSubmissionToken({
      label: 'Night Shift', teamId: held.teamId, issuedBy: ACTOR,
    }))

    const plan = await run(true)
    expect(plan.issued).toBe(false)
    expect(plan.refusal).toMatch(/Every team already holds a working token/)
  })

  it('says where teams come from when there are none', async () => {
    const plan = await run(true)
    expect(plan.refusal).toMatch(/no teams yet.*roster/i)
  })

  it('records the issue without any token in the payload (P8.3)', async () => {
    await team('Night Shift')
    const plan = await run(true)

    const audit = await query<{ payload: { issued: number } }>(
      `SELECT payload FROM audit_event WHERE action = 'submissions.tokens_bulk_issued'
        ORDER BY event_id DESC LIMIT 1`)
    expect(audit.rows[0]!.payload.issued).toBe(1)
    expect(JSON.stringify(audit.rows)).not.toContain(plan.rows[0]!.token)
  })

  it('creates no second team — it issues against the ones that exist', async () => {
    await team('Night Shift')
    await run(true)
    expect(await getTeams()).toHaveLength(1)
  })
})
