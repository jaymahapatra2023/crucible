/**
 * Coaches confirming they are at the venue (migration 105).
 *
 * The number that matters is TEAMS uncovered, not coaches missing. Fourteen of thirty-four take
 * two teams each, so those are different numbers and only one of them is actionable.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { provisionSlots } from '../../src/modules/roster/services/slotService.js'
import { arrivalState, confirmArrival } from '../../src/modules/roster/services/arrivalService.js'
import { listCoachNames } from '../../src/modules/roster/db/arrivalDb.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'arrival' }, fn)

const ROOMS = ['label,location,capacity,teams', 'Hall A,First floor,40,4'].join('\n')
const COACHES = ['name,email,teams',
  'Margaret Hamilton,margaret@example.test,2',
  'Katherine J,kj@example.test,1',
  'Unassigned Coach,spare@example.test,1'].join('\n')
const SLOTS = ['label,room,coach',
  'Team 1,Hall A,Margaret Hamilton',
  'Team 2,Hall A,Margaret Hamilton',
  'Team 3,Hall A,Katherine J'].join('\n')

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  for (const [kind, csv] of [['room', ROOMS], ['coach', COACHES]] as const) {
    await inScope(() => importRoster({ kind, csv, confirm: true, actor: ACTOR }))
  }
  await inScope(() => provisionSlots({ csv: SLOTS, confirm: true, actor: ACTOR }))
})

describe('the public list', () => {
  it('offers names and nothing else', async () => {
    const names = await listCoachNames()
    expect(names).toEqual(['Katherine J', 'Margaret Hamilton', 'Unassigned Coach'])
    // A coach's name is on the door already; their address is not, and this list has no use for it.
    expect(JSON.stringify(names)).not.toMatch(/@/)
  })
})

describe('confirming', () => {
  it('answers a name on the list and one that is not with the same sentence', async () => {
    const hit = await inScope(() => confirmArrival({ fullName: 'Margaret Hamilton' }))
    const miss = await inScope(() => confirmArrival({ fullName: 'Nobody At All' }))
    expect(hit.message).toBe(miss.message)
  })

  it('marks them here, and counts their teams as covered', async () => {
    const before = await arrivalState()
    expect(before.summary).toMatchObject({ total: 3, arrived: 0, missing: 3, teamsUncovered: 3 })

    await inScope(() => confirmArrival({ fullName: 'Margaret Hamilton' }))

    const after = await arrivalState()
    // Margaret holds TWO of the three teams, so one confirmation moves the number by two.
    expect(after.summary).toMatchObject({ arrived: 1, missing: 2, teamsUncovered: 1 })
  })

  it('counts TEAMS uncovered, not coaches missing', async () => {
    // The whole reason the view exists. Two coaches missing is not two teams.
    await inScope(() => confirmArrival({ fullName: 'Katherine J' }))
    const state = await arrivalState()
    expect(state.summary.missing).toBe(2)          // Margaret and the spare
    expect(state.summary.teamsUncovered).toBe(2)   // both of Margaret's; the spare has none
  })

  it('keeps the FIRST timestamp when somebody taps twice', async () => {
    await inScope(() => confirmArrival({ fullName: 'Margaret Hamilton' }))
    const first = (await arrivalState()).coaches.find((c) => c.fullName === 'Margaret Hamilton')!
    await inScope(() => confirmArrival({ fullName: 'Margaret Hamilton' }))
    const again = (await arrivalState()).coaches.find((c) => c.fullName === 'Margaret Hamilton')!
    expect(again.arrivedAt).toEqual(first.arrivedAt)
  })

  it('matches a name however it was capitalised or spaced', async () => {
    await inScope(() => confirmArrival({ fullName: '  margaret   hamilton ' }))
    expect((await arrivalState()).summary.arrived).toBe(1)
  })

  it('records the arrival in the audit trail, by id and with no personal data', async () => {
    await inScope(() => confirmArrival({ fullName: 'Margaret Hamilton' }))
    const audit = await query<{ subject_id: string; payload: unknown }>(
      "SELECT subject_id, payload FROM audit_event WHERE action = 'roster.coach_arrived'")
    expect(audit.rows).toHaveLength(1)
    expect(JSON.stringify(audit.rows[0]!.payload)).not.toMatch(/@|Margaret/)
  })

  it('records nothing at all for a name that matched nobody', async () => {
    await inScope(() => confirmArrival({ fullName: 'Nobody At All' }))
    const audit = await query(
      "SELECT 1 FROM audit_event WHERE action = 'roster.coach_arrived'")
    expect(audit.rows).toHaveLength(0)
  })

  it('leaves an inactive coach out of the list and unmarkable', async () => {
    await query("UPDATE coach SET active = FALSE WHERE full_name = 'Katherine J'")
    expect(await listCoachNames()).not.toContain('Katherine J')
    await inScope(() => confirmArrival({ fullName: 'Katherine J' }))
    expect((await arrivalState()).summary.arrived).toBe(0)
  })
})
