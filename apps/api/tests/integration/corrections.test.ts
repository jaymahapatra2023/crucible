/**
 * Participants confirming their own details (migration 104).
 *
 * The two properties that make a public page safe here, and one that makes it useful:
 * it reveals nothing, it changes nothing without a human, and approving either corrects the
 * person it matched or adds the person it did not.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { decide, submitCorrection } from '../../src/modules/roster/services/correctionService.js'
import { listCorrections } from '../../src/modules/roster/db/correctionDb.js'
import { listParticipants } from '../../src/modules/roster/db/rosterDb.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'corrections' }, fn)

const PEOPLE = ['full_name,email',
  'Ada Lovelace,placeholder+ada@example.test',
  'Grace Hopper,grace@example.test',
  'Grace Hopper,grace2@example.test'].join('\n')

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  await inScope(() => importRoster({
    kind: 'participant', csv: PEOPLE, confirm: true, actor: ACTOR,
  }))
})

const find = async (email: string) =>
  (await listParticipants()).find((p) => p.email === email)

describe('the public claim reveals nothing', () => {
  it('answers a name that IS on the list and one that is not with the same sentence', async () => {
    const hit = await submitCorrection({ fullName: 'Ada Lovelace', email: 'ada@real.test' })
    const miss = await submitCorrection({ fullName: 'Nobody At All', email: 'x@real.test' })
    expect(hit.message).toBe(miss.message)
    expect(hit.received).toBe(true)
    expect(miss.received).toBe(true)
  })

  it('answers an AMBIGUOUS name the same way too', async () => {
    // Two Grace Hoppers. Picking either would be a coin toss over whose address gets rewritten,
    // and saying "which one?" would confirm that two are here.
    const both = await submitCorrection({ fullName: 'Grace Hopper', email: 'g@real.test' })
    const miss = await submitCorrection({ fullName: 'Nobody At All', email: 'x@real.test' })
    expect(both.message).toBe(miss.message)
  })

  it('changes nothing on the roster by itself', async () => {
    await submitCorrection({ fullName: 'Ada Lovelace', email: 'ada@real.test' })
    expect(await find('placeholder+ada@example.test')).toBeDefined()
    expect(await find('ada@real.test')).toBeUndefined()
  })

  it('records the claim either way, so a walk-in nobody wrote down is not lost', async () => {
    await submitCorrection({ fullName: 'Ada Lovelace', email: 'ada@real.test' })
    await submitCorrection({ fullName: 'Nobody At All', email: 'nobody@real.test' })
    const queue = await listCorrections('PENDING')
    expect(queue).toHaveLength(2)
    expect(queue.map((c) => c.kind).sort()).toEqual(['ADD', 'CORRECTION'])
  })

  it('does not match an ambiguous name to either person', async () => {
    await submitCorrection({ fullName: 'Grace Hopper', email: 'g@real.test' })
    const [claim] = await listCorrections('PENDING')
    expect(claim!.participantId).toBeNull()
    expect(claim!.kind).toBe('ADD')
  })
})

describe('an organiser decides', () => {
  it('CORRECTS the matched person, name and address together', async () => {
    await submitCorrection({ fullName: 'Ada Lovelace', email: 'ada@real.test' })
    const [claim] = await listCorrections('PENDING')

    const outcome = await inScope(() => decide({
      correctionId: claim!.correctionId, approve: true, actor: ACTOR,
    }))
    expect(outcome).toMatchObject({ status: 'APPLIED', effect: 'CORRECTED' })
    expect(await find('ada@real.test')).toMatchObject({ fullName: 'Ada Lovelace' })
    expect(await find('placeholder+ada@example.test')).toBeUndefined()
  })

  it('ADDS somebody who was not on the list at all', async () => {
    await submitCorrection({ fullName: 'Walk In', email: 'walkin@real.test' })
    const [claim] = await listCorrections('PENDING')

    const outcome = await inScope(() => decide({
      correctionId: claim!.correctionId, approve: true, actor: ACTOR,
    }))
    expect(outcome).toMatchObject({ status: 'APPLIED', effect: 'ADDED' })
    expect(await find('walkin@real.test')).toMatchObject({ fullName: 'Walk In' })
  })

  it('leaves the roster alone when rejected', async () => {
    await submitCorrection({ fullName: 'Ada Lovelace', email: 'ada@real.test' })
    const [claim] = await listCorrections('PENDING')
    const outcome = await inScope(() => decide({
      correctionId: claim!.correctionId, approve: false, actor: ACTOR,
    }))
    expect(outcome).toMatchObject({ status: 'REJECTED', effect: 'NONE' })
    expect(await find('placeholder+ada@example.test')).toBeDefined()
  })

  it('cannot be decided twice', async () => {
    // Two organisers pressing at once both reach the update; only one touches a row.
    await submitCorrection({ fullName: 'Ada Lovelace', email: 'ada@real.test' })
    const [claim] = await listCorrections('PENDING')
    await inScope(() => decide({ correctionId: claim!.correctionId, approve: true, actor: ACTOR }))
    await expect(inScope(() => decide({
      correctionId: claim!.correctionId, approve: true, actor: ACTOR,
    }))).rejects.toThrow(/already applied/i)
  })

  it('records the decision without an address in the audit payload', async () => {
    await submitCorrection({ fullName: 'Ada Lovelace', email: 'ada@real.test' })
    const [claim] = await listCorrections('PENDING')
    await inScope(() => decide({ correctionId: claim!.correctionId, approve: true, actor: ACTOR }))

    const audit = await query<{ payload: unknown }>(
      "SELECT payload FROM audit_event WHERE action = 'roster.correction_applied'")
    expect(audit.rows).toHaveLength(1)
    expect(JSON.stringify(audit.rows[0]!.payload)).not.toMatch(/@/)
  })
})
