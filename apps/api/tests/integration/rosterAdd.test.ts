/**
 * Adding one record by hand (E31-S01, E31-S02).
 *
 * The import exists for two hundred people loaded before the day. These three paths exist for the
 * one who arrives on the morning — and the point of testing them together with the import is that
 * a record added by hand must be indistinguishable from an imported one afterwards. A second path
 * that produced subtly different rows would be a second definition of what a participant is.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import {
  addCoach, addParticipant, addRoom, getCoaches, getRooms,
} from '../../src/modules/roster/services/rosterService.js'
import { listParticipants } from '../../src/modules/roster/db/rosterDb.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'roster-add' }, fn)

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
})

describe('adding a participant by hand', () => {
  it('produces a record the import cannot be told apart from its own', async () => {
    await inScope(() => importRoster({
      kind: 'participant', csv: 'full_name,email\nAda Lovelace,ada@example.test',
      confirm: true, actor: ACTOR,
    }))
    const added = await inScope(() => addParticipant({
      fullName: 'Grace Hopper', email: 'grace@example.test', actor: ACTOR,
    }))

    const all = await listParticipants()
    expect(all).toHaveLength(2)
    // Same shape, same defaults: notes empty rather than null, organisation absent rather than ''.
    expect(added.notes).toBe('')
    expect(added.organisation).toBeNull()
    expect(Object.keys(added).sort()).toEqual(Object.keys(all[0]!).sort())
  })

  it('refuses a duplicate address by naming who already has it', async () => {
    await inScope(() => addParticipant({
      fullName: 'Ada Lovelace', email: 'ada@example.test', actor: ACTOR,
    }))
    await expect(inScope(() => addParticipant({
      fullName: 'Ada L', email: 'ADA@example.test', actor: ACTOR,
    }))).rejects.toThrow(/Ada Lovelace is already on the roster/)

    expect(await listParticipants()).toHaveLength(1)
  })

  it('is then found by the import as existing, not created twice', async () => {
    await inScope(() => addParticipant({
      fullName: 'Ada Lovelace', email: 'ada@example.test', actor: ACTOR,
    }))
    const plan = await inScope(() => importRoster({
      kind: 'participant', csv: 'full_name,email\nAda Lovelace,ada@example.test',
      confirm: false, actor: ACTOR,
    }))
    expect(plan.rows[0]?.outcome).toBe('EXISTING')
  })

  it('records the addition without putting an address in the audit trail (P8.3)', async () => {
    const added = await inScope(() => addParticipant({
      fullName: 'Ada Lovelace', email: 'ada@example.test', actor: ACTOR,
    }))
    const audit = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_event
        WHERE action = 'roster.participant_added' AND subject_id = $1`,
      [String(added.participantId)])

    expect(audit.rows).toHaveLength(1)
    expect(JSON.stringify(audit.rows[0])).not.toContain('ada@example.test')
    expect(JSON.stringify(audit.rows[0])).not.toContain('Ada Lovelace')
  })
})

describe('adding a room by hand', () => {
  it('refuses a label that already exists, because a room name has to find the room', async () => {
    await inScope(() => addRoom({ label: 'Ada', location: 'First floor', actor: ACTOR }))
    await expect(inScope(() => addRoom({ label: 'Ada', actor: ACTOR })))
      .rejects.toThrow(/A room labelled Ada already exists/)

    expect(await getRooms()).toHaveLength(1)
  })

  it('arrives in use, with an absent capacity kept absent rather than zeroed (P5.1)', async () => {
    const room = await inScope(() => addRoom({ label: 'Babbage', actor: ACTOR }))
    expect(room.inUse).toBe(true)
    expect(room.capacity).toBeNull()
    expect(room.location).toBe('')
  })
})

describe('adding a coach by hand', () => {
  it('arrives active and on no team — a coach is not a participant', async () => {
    const coach = await inScope(() => addCoach({
      fullName: 'Margaret Hamilton', email: 'margaret@example.test', actor: ACTOR,
    }))
    expect(coach.active).toBe(true)

    // The separation E27-S02 acceptance 3 insists on: nothing about adding a coach touches the
    // participant list, so they can never be picked up by the assignment surface.
    expect(await listParticipants()).toHaveLength(0)
  })

  it('refuses a duplicate address by naming the existing coach', async () => {
    await inScope(() => addCoach({
      fullName: 'Margaret Hamilton', email: 'margaret@example.test', actor: ACTOR,
    }))
    await expect(inScope(() => addCoach({
      fullName: 'M Hamilton', email: 'margaret@example.test', actor: ACTOR,
    }))).rejects.toThrow(/Margaret Hamilton is already a coach/)

    expect(await getCoaches()).toHaveLength(1)
  })
})
