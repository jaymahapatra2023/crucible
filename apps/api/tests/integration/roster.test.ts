/**
 * The roster: people, rooms and coaches (E27).
 *
 * Three lists loaded before an event and edited on it. None of them is a Crucible user; a coach
 * is deliberately not a participant; and a participant list is personal data, which shows up in
 * the schema rather than in a policy document.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import {
  assignLogistics, getCoaches, getLogistics, getRooms, removeParticipant,
  reviseCoach, reviseParticipant, reviseRoom,
} from '../../src/modules/roster/services/rosterService.js'
import { listParticipants, selectParticipantByEmail } from '../../src/modules/roster/db/rosterDb.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'roster' }, fn)

const PEOPLE = [
  'full_name,email,organisation',
  'Ada Lovelace,ada@example.test,Analytical Engines',
  'Grace Hopper,grace@example.test,Navy',
  'Alan Turing,alan@example.test,NPL',
].join('\n')

const ROOMS = [
  'label,location,capacity',
  'Ada,First floor,6',
  'Babbage,First floor,6',
  'Turing,Second floor,4',
].join('\n')

const COACHES = [
  'full_name,email',
  'Margaret Hamilton,margaret@example.test',
  'Katherine Johnson,katherine@example.test',
].join('\n')

const load = (kind: 'participant' | 'room' | 'coach', csv: string, confirm = true) =>
  inScope(() => importRoster({ kind, csv, confirm, actor: ACTOR }))

/** A team to give logistics to. Teams belong to the submissions module; this borrows two. */
async function seedTeams(count = 2): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const row = await query<{ team_id: number }>(
      `INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ($1, $2, 'ORGANISER', 'fixture') RETURNING team_id`,
      [`Team ${i + 1}`, `team${i + 1}@example.test`])
    ids.push(Number(row.rows[0]!.team_id))
  }
  return ids
}

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
})

describe('loading a list', () => {
  it('plans without writing anything', async () => {
    const plan = await load('participant', PEOPLE, false)
    expect(plan.summary).toMatchObject({ total: 3, new: 3, existing: 0 })
    expect(plan.imported).toBe(false)
    expect(await listParticipants()).toHaveLength(0)
  })

  it('writes when confirmed', async () => {
    const plan = await load('participant', PEOPLE)
    expect(plan.imported).toBe(true)
    expect(await listParticipants()).toHaveLength(3)
    expect(plan.rows.every((r) => r.id !== null)).toBe(true)
  })

  it('accepts the column names people actually type', async () => {
    const plan = await load('participant', 'Name,E-Mail\nAda Lovelace,ada@example.test')
    expect(plan.rows[0]).toMatchObject({ label: 'Ada Lovelace', outcome: 'NEW' })
  })

  it('reports somebody already on the list as EXISTING, not as an error', async () => {
    // Re-uploading a corrected list is the normal way this gets used. Treating the second
    // upload as 200 conflicts would make correction impossible.
    await load('participant', PEOPLE)
    const again = await load('participant', PEOPLE)

    expect(again.summary).toMatchObject({ total: 3, new: 0, existing: 3, invalid: 0 })
    expect(again.imported).toBe(true)
    expect(await listParticipants()).toHaveLength(3)
  })

  it('matches an existing person case- and space-insensitively', async () => {
    await load('participant', PEOPLE)
    const again = await load('participant', 'name,email\nAda L,  ADA@EXAMPLE.TEST ')
    expect(again.rows[0]!.outcome).toBe('EXISTING')
  })

  it('names what is wrong with a row, per row', async () => {
    const plan = await load('participant', [
      'full_name,email',
      'A,short@example.test',
      'No Address,',
      'Bad Address,nope',
      'Fine Person,fine@example.test',
    ].join('\n'), false)

    expect(plan.rows.map((r) => r.outcome)).toEqual(['INVALID', 'INVALID', 'INVALID', 'NEW'])
    expect(plan.rows[0]!.detail).toMatch(/too short/)
    expect(plan.rows[1]!.detail).toMatch(/how this person is identified/)
    expect(plan.rows[2]!.detail).toMatch(/not an email address/)
  })

  it('catches the same address twice in one file, naming the earlier line', async () => {
    const plan = await load('participant',
      'full_name,email\nAda,ada@example.test\nAda Again,ada@example.test', false)
    expect(plan.rows[1]!.outcome).toBe('DUPLICATE')
    expect(plan.rows[1]!.detail).toMatch(/line 2/)
  })

  it('REFUSES THE WHOLE FILE when any row cannot be acted on', async () => {
    const plan = await load('participant',
      'full_name,email\nGood Person,good@example.test\nBad,nope')

    expect(plan.imported).toBe(false)
    expect(plan.refusal).toMatch(/Nothing was imported/)
    expect(await listParticipants()).toHaveLength(0)
  })

  it('refuses a file with no header naming the columns', async () => {
    await expect(load('participant', 'Ada,ada@example.test'))
      .rejects.toThrow(/header row is missing/)
  })

  it('refuses an empty file as empty', async () => {
    await expect(load('participant', '   ')).rejects.toThrow(/file is empty/)
  })

  it('records the import WITHOUT anybody\'s address (P8.3)', async () => {
    await load('participant', PEOPLE)
    const audit = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_event WHERE action = 'roster.participants_imported'`)

    expect(audit.rows[0]!.payload).toMatchObject({ created: 3, existing: 0 })
    expect(JSON.stringify(audit.rows)).not.toContain('ada@example.test')
  })
})

describe('rooms and coaches load the same way', () => {
  it('loads rooms with their capacity', async () => {
    await load('room', ROOMS)
    const rooms = await getRooms()
    expect(rooms).toHaveLength(3)
    expect(rooms.find((r) => r.label === 'Turing')).toMatchObject({
      capacity: 4, location: 'Second floor', inUse: true,
    })
  })

  it('refuses a capacity that is not a number of people', async () => {
    const plan = await load('room', 'label,capacity\nAda,lots', false)
    expect(plan.rows[0]!.detail).toMatch(/not a number of people/)
  })

  it('loads the TEAM limit as well, under either column name (migration 101)', async () => {
    // The venue plan gives two numbers per room and neither follows from the other: the Dining
    // Room seats 100 people and takes 12 teams; room 418 seats 8 and takes 1.
    await load('room', 'label,location,capacity,teams\nDining Room,Greene 3,100,12')
    await load('room', 'label,location,capacity,team_capacity\n418,Greene 4,8,1')
    const rooms = await getRooms()
    expect(rooms.find((r) => r.label === 'Dining Room')).toMatchObject({
      capacity: 100, teamCapacity: 12, location: 'Greene 3',
    })
    expect(rooms.find((r) => r.label === '418')).toMatchObject({
      capacity: 8, teamCapacity: 1, location: 'Greene 4',
    })
  })

  it('names the TEAM column when it is the one that is wrong', async () => {
    // The obvious mistake is the two columns swapped, and "not a number" would not say which
    // one to go and look at.
    const plan = await load('room', 'label,capacity,teams\nAda,20,several', false)
    expect(plan.rows[0]!.detail).toMatch(/not a number of teams/)
  })

  it('leaves the TEAM limit unset when the file does not give one', async () => {
    await load('room', 'label,capacity\nNo Plan Yet,30')
    expect((await getRooms()).find((r) => r.label === 'No Plan Yet')?.teamCapacity).toBeNull()
  })

  it('loads a coach with the number of teams they agreed to take (migration 102)', async () => {
    // The volunteer register asks each primary coach this. 20 said one, 14 said two, and the
    // figure decides whether every team has a coach at all.
    await load('coach', 'full_name,email,teams\nJosh Humpherys,josh@example.test,2')
    const coaches = await getCoaches()
    expect(coaches.find((c) => c.email === 'josh@example.test')).toMatchObject({
      fullName: 'Josh Humpherys', teamCapacity: 2,
    })
  })

  it('leaves a coach team count unset when the file does not give one', async () => {
    // Null is not one: it means nobody asked.
    await load('coach', 'full_name,email\nDavida Neal,davida@example.test')
    expect((await getCoaches()).find((c) => c.email === 'davida@example.test')?.teamCapacity)
      .toBeNull()
  })

  it('refuses a coach team count that is not a number of teams', async () => {
    const plan = await load('coach', 'full_name,email,teams\nX Y,xy@example.test,lots', false)
    expect(plan.rows[0]!.detail).toMatch(/not a number of teams/)
  })

  it('reports each coach\'s load against what they agreed to', async () => {
    await load('coach', 'full_name,email,teams\nSolo Coach,solo@example.test,1')
    const coach = (await getCoaches()).find((c) => c.email === 'solo@example.test')!
    const [a, b] = await seedTeams(2)
    for (const teamId of [a!, b!]) {
      await inScope(() => assignLogistics({ teamId, coachId: coach.coachId, actor: ACTOR }))
    }
    const load_ = await query<{ teams: number; team_capacity: number; over_team_capacity: boolean }>(
      'SELECT teams, team_capacity, over_team_capacity FROM v_roster_coach_load WHERE coach_id = $1',
      [coach.coachId])
    expect(Number(load_.rows[0]?.teams)).toBe(2)
    expect(load_.rows[0]?.over_team_capacity).toBe(true)
  })

  it('treats a room already loaded as existing, matched on its label', async () => {
    await load('room', ROOMS)
    expect((await load('room', 'label\n  ada  ')).summary.existing).toBe(1)
  })

  it('loads coaches, who are NOT participants', async () => {
    await load('coach', COACHES)
    expect(await getCoaches()).toHaveLength(2)
    // The distinction that matters: a coach helps produce the work, so counting one as a
    // participant would put them inside the thing being judged.
    expect(await selectParticipantByEmail('margaret@example.test')).toBeNull()
  })
})

describe('editing what was loaded', () => {
  it('corrects a participant and records WHICH fields moved, not their values', async () => {
    await load('participant', PEOPLE)
    const person = (await listParticipants())[0]!

    await inScope(() => reviseParticipant({
      participantId: person.participantId, fullName: 'Augusta Ada King', actor: ACTOR,
    }))

    const audit = await query<{ payload: { changed: string[] } }>(
      `SELECT payload FROM audit_event WHERE action = 'roster.participant_changed'`)
    expect(audit.rows[0]!.payload.changed).toEqual(['fullName'])
    expect(JSON.stringify(audit.rows)).not.toContain('Augusta')
  })

  it('takes a room out of use without deleting it', async () => {
    // A room used yesterday still has to exist for the record of where a team sat to resolve.
    await load('room', ROOMS)
    const room = (await getRooms())[0]!
    await inScope(() => reviseRoom({ roomId: room.roomId, inUse: false, actor: ACTOR }))

    const after = (await getRooms()).find((r) => r.roomId === room.roomId)!
    expect(after.inUse).toBe(false)
    expect(await getRooms()).toHaveLength(3)
  })

  it('deactivates a coach without losing them', async () => {
    await load('coach', COACHES)
    const coach = (await getCoaches())[0]!
    await inScope(() => reviseCoach({ coachId: coach.coachId, active: false, actor: ACTOR }))
    expect((await getCoaches()).find((c) => c.coachId === coach.coachId)!.active).toBe(false)
  })

  it('refuses to edit somebody who is not there', async () => {
    await expect(inScope(() => reviseParticipant({
      participantId: 999_999, fullName: 'Nobody At All', actor: ACTOR,
    }))).rejects.toThrow(/was not found/)
  })
})

describe('removing a participant', () => {
  it('is a soft delete carrying a reason (P7.4)', async () => {
    await load('participant', PEOPLE)
    const person = (await listParticipants())[0]!

    await inScope(() => removeParticipant({
      participantId: person.participantId, reason: 'GDPR_ERASURE', actor: ACTOR,
    }))

    expect(await listParticipants()).toHaveLength(2)
    const row = await query<{ delete_reason: string; deleted_by: string }>(
      'SELECT delete_reason, deleted_by FROM participant WHERE participant_id = $1',
      [person.participantId])
    expect(row.rows[0]).toMatchObject({ delete_reason: 'GDPR_ERASURE', deleted_by: ACTOR })
  })

  it('frees their address for a later registration', async () => {
    await load('participant', PEOPLE)
    const person = (await selectParticipantByEmail('ada@example.test'))!
    await inScope(() => removeParticipant({
      participantId: person.participantId, reason: 'USER_REQUEST', actor: ACTOR,
    }))

    const again = await load('participant', 'full_name,email\nAda Lovelace,ada@example.test')
    expect(again.summary.new).toBe(1)
  })

  it('REFUSES while they are on a team, and says to unassign first', async () => {
    await load('participant', PEOPLE)
    const person = (await listParticipants())[0]!
    await expect(inScope(() => removeParticipant({
      participantId: person.participantId, reason: 'ADMIN_ACTION', actor: ACTOR, onTeam: true,
    }))).rejects.toThrow(/Take them off it first/)
  })

  it('refuses to remove somebody already removed', async () => {
    await load('participant', PEOPLE)
    const person = (await listParticipants())[0]!
    const remove = () => inScope(() => removeParticipant({
      participantId: person.participantId, reason: 'ADMIN_ACTION', actor: ACTOR,
    }))
    await remove()
    await expect(remove()).rejects.toThrow(/already been removed/)
  })
})

describe('giving a team a place and a coach', () => {
  it('assigns both, and resolves their labels', async () => {
    await load('room', ROOMS)
    await load('coach', COACHES)
    const [teamId] = await seedTeams(1)
    const room = (await getRooms())[0]!
    const coach = (await getCoaches())[0]!

    const after = await inScope(() => assignLogistics({
      teamId: teamId!, roomId: room.roomId, coachId: coach.coachId, actor: ACTOR,
    }))
    expect(after).toMatchObject({ roomLabel: room.label, coachName: coach.fullName })
  })

  it('puts SEVERAL teams in one room — a hall holds more than one', async () => {
    // It used to refuse (a unique index). That was wrong for an event that seats four teams to a
    // hall; the crowding is reported through v_roster_room_load and the organiser decides
    // (migration 096).
    await load('room', ROOMS)
    const [first, second] = await seedTeams(2)
    const room = (await getRooms())[0]!

    await inScope(() => assignLogistics({ teamId: first!, roomId: room.roomId, actor: ACTOR }))
    await expect(inScope(() => assignLogistics({
      teamId: second!, roomId: room.roomId, actor: ACTOR,
    }))).resolves.toMatchObject({ roomLabel: room.label })

    const load_ = await query<{ teams: number; capacity: number | null; over_capacity: boolean }>(
      'SELECT teams, capacity, over_capacity FROM v_roster_room_load WHERE room_id = $1',
      [room.roomId])
    expect(Number(load_.rows[0]?.teams)).toBe(2)
    // Nobody is on either team yet, so no seat is taken and nothing is over capacity.
    expect(load_.rows[0]?.over_capacity).toBe(false)
  })

  it('reports a room as over capacity once more people are in it than it seats', async () => {
    // Advisory only: it says so and refuses nothing, because the person assigning can see the
    // room and a refusal on the morning would be obstructive.
    await load('room', ['label,location,capacity', 'Tiny,Corner,1'].join('\n'))
    await load('participant', PEOPLE)
    const [team] = await seedTeams(1)
    const room = (await getRooms()).find((r) => r.label === 'Tiny')!
    await inScope(() => assignLogistics({ teamId: team!, roomId: room.roomId, actor: ACTOR }))

    // Members inserted directly: this test is about what the room-load view reports, not about
    // the assignment path, which reads teams through a port this suite does not install.
    for (const person of (await listParticipants(10, 0)).slice(0, 2)) {
      await query(
        `INSERT INTO team_member (team_id, participant_id, is_contact, assigned_by)
         VALUES ($1, $2, FALSE, $3)`,
        [team!, person.participantId, ACTOR])
    }

    const row = await query<{ people: number; over_capacity: boolean }>(
      'SELECT people, over_capacity FROM v_roster_room_load WHERE room_id = $1', [room.roomId])
    expect(Number(row.rows[0]?.people)).toBe(2)
    expect(row.rows[0]?.over_capacity).toBe(true)
  })

  it('lets a coach take more than one team — that is a judgement, not an error', async () => {
    await load('coach', COACHES)
    const [first, second] = await seedTeams(2)
    const coach = (await getCoaches())[0]!

    await inScope(() => assignLogistics({ teamId: first!, coachId: coach.coachId, actor: ACTOR }))
    await expect(inScope(() => assignLogistics({
      teamId: second!, coachId: coach.coachId, actor: ACTOR,
    }))).resolves.toMatchObject({ coachName: coach.fullName })
  })

  it('leaves the field it was not told about alone', async () => {
    // A screen that sends the whole object on every save would otherwise clear the coach when
    // the operator only moved the room.
    await load('room', ROOMS)
    await load('coach', COACHES)
    const [teamId] = await seedTeams(1)
    const rooms = await getRooms()
    const coach = (await getCoaches())[0]!

    await inScope(() => assignLogistics({
      teamId: teamId!, roomId: rooms[0]!.roomId, coachId: coach.coachId, actor: ACTOR,
    }))
    const after = await inScope(() => assignLogistics({
      teamId: teamId!, roomId: rooms[1]!.roomId, actor: ACTOR,
    }))

    expect(after.roomLabel).toBe(rooms[1]!.label)
    expect(after.coachName).toBe(coach.fullName)
  })

  it('clears a field told explicitly to clear it, freeing the room', async () => {
    await load('room', ROOMS)
    const [first, second] = await seedTeams(2)
    const room = (await getRooms())[0]!

    await inScope(() => assignLogistics({ teamId: first!, roomId: room.roomId, actor: ACTOR }))
    await inScope(() => assignLogistics({ teamId: first!, roomId: null, actor: ACTOR }))

    await expect(inScope(() => assignLogistics({
      teamId: second!, roomId: room.roomId, actor: ACTOR,
    }))).resolves.toMatchObject({ roomLabel: room.label })
  })

  it('records the move with what it was before', async () => {
    await load('room', ROOMS)
    const [teamId] = await seedTeams(1)
    const rooms = await getRooms()

    await inScope(() => assignLogistics({ teamId: teamId!, roomId: rooms[0]!.roomId, actor: ACTOR }))
    await inScope(() => assignLogistics({ teamId: teamId!, roomId: rooms[1]!.roomId, actor: ACTOR }))

    const audit = await query<{ payload: { room: { from: string; to: string } } }>(
      `SELECT payload FROM audit_event WHERE action = 'roster.logistics_assigned'
        ORDER BY event_id DESC LIMIT 1`)
    expect(audit.rows[0]!.payload.room).toMatchObject({
      from: rooms[0]!.label, to: rooms[1]!.label,
    })
  })

  it('refuses an assignment that names neither a room nor a coach', async () => {
    const [teamId] = await seedTeams(1)
    await expect(inScope(() => assignLogistics({ teamId: teamId!, actor: ACTOR })))
      .rejects.toThrow(/Name a room, a coach, or both/)
  })

  it('reports a team with no logistics as having none, rather than omitting it', async () => {
    await seedTeams(1)
    expect(await getLogistics()).toHaveLength(0)
  })
})
