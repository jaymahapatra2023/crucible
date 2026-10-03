/**
 * Roster contract tests (E27, P8.1).
 *
 * The access question is the important one here: a participant list is 200 people's names and
 * addresses. It is not on the public allow-list, and a viewer — who may read scores — has no
 * business reading it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { query } from '../../src/db/pool.js'

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser
let viewer: TestUser

const PEOPLE = 'full_name,email\nAda Lovelace,ada@example.test\nGrace Hopper,grace@example.test'

const load = (kind: string, csv: string, confirm: boolean, user = organiser) => app.inject({
  method: 'POST', url: '/api/v1/roster/import',
  headers: authHeader(user), payload: { kind, csv, confirm },
})

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  app = await getApp()
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
  viewer = await makeUser('viewer')
})

afterAll(async () => closeApp())

describe('who may read a participant list (P8.1)', () => {
  it('refuses it without a token at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster/participants' })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a VIEWER — reading scores is not reading personal data', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/participants', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a REVIEWER too', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/participants', headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('allows an ORGANISER', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/participants', headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses an import from anyone below organiser', async () => {
    expect((await load('participant', PEOPLE, false, viewer)).statusCode).toBe(403)
    expect((await load('participant', PEOPLE, false, reviewer)).statusCode).toBe(403)
  })

  it('lets a VIEWER read logistics — a room number is not personal data', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/logistics', headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('importing over HTTP', () => {
  it('plans without writing when it is not confirmed', async () => {
    const res = await load('participant', PEOPLE, false)
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: { imported: boolean; summary: { new: number } } }).data
    expect(data).toMatchObject({ imported: false })
    expect(data.summary.new).toBe(2)

    const after = await app.inject({
      method: 'GET', url: '/api/v1/roster/participants', headers: authHeader(organiser),
    })
    expect((after.json() as { data: { total: number } }).data.total).toBe(0)
  })

  it('writes when confirmed, and reports the real backend total (P5.7)', async () => {
    await load('participant', PEOPLE, true)
    // `pageSize`, not `limit`: E40 moved this endpoint onto the same pagination contract as
    // every other list in the system rather than keeping a second spelling of one idea.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/participants?pageSize=1',
      headers: authHeader(organiser),
    })
    const data = (res.json() as { data: { participants: unknown[]; total: number } }).data
    expect(data.participants).toHaveLength(1)
    // The count is the number of participants, not the number this response carried.
    expect(data.total).toBe(2)
  })

  it('refuses a kind it does not know', async () => {
    expect((await load('speakers', PEOPLE, false)).statusCode).toBe(400)
  })

  it('refuses a body too large to be a roster', async () => {
    expect((await load('participant', 'x'.repeat(600_000), false)).statusCode).toBe(400)
  })
})

describe('editing over HTTP', () => {
  async function onePerson(): Promise<number> {
    await load('participant', PEOPLE, true)
    const res = await app.inject({
      method: 'GET', url: '/api/v1/roster/participants', headers: authHeader(organiser),
    })
    return (res.json() as { data: { participants: Array<{ participantId: number }> } })
      .data.participants[0]!.participantId
  }

  it('corrects a field and leaves the others alone', async () => {
    const id = await onePerson()
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/roster/participants/${id}`,
      headers: authHeader(organiser), payload: { organisation: 'Analytical Engines' },
    })
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: { organisation: string; fullName: string } }).data
    expect(data.organisation).toBe('Analytical Engines')
    expect(data.fullName).toBeTruthy()
  })

  it('CLEARS a field told explicitly to clear it', async () => {
    // Absent means leave it; null means clear it. A screen sending the whole object on save
    // would otherwise be unable to remove an organisation it had set.
    const id = await onePerson()
    await app.inject({
      method: 'PATCH', url: `/api/v1/roster/participants/${id}`,
      headers: authHeader(organiser), payload: { organisation: 'Navy' },
    })
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/roster/participants/${id}`,
      headers: authHeader(organiser), payload: { organisation: null },
    })
    expect((res.json() as { data: { organisation: string | null } }).data.organisation).toBeNull()
  })

  it('refuses an address that is not one', async () => {
    const id = await onePerson()
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/roster/participants/${id}`,
      headers: authHeader(organiser), payload: { email: 'not-an-address' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('removes with a reason, and the reason is recorded (P7.4)', async () => {
    const id = await onePerson()
    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/roster/participants/${id}?reason=GDPR_ERASURE`,
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(204)

    const row = await query<{ delete_reason: string }>(
      'SELECT delete_reason FROM participant WHERE participant_id = $1', [id])
    expect(row.rows[0]!.delete_reason).toBe('GDPR_ERASURE')
  })

  it('refuses a removal reason outside the enum', async () => {
    const id = await onePerson()
    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/roster/participants/${id}?reason=BECAUSE`,
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('assigning a room and a coach over HTTP', () => {
  it('assigns, and lets a second team share the same room', async () => {
    await load('room', 'label,capacity\nAda,6\nBabbage,6', true)
    await load('coach', 'full_name,email\nMargaret Hamilton,margaret@example.test', true)

    const rooms = (await app.inject({
      method: 'GET', url: '/api/v1/roster/rooms', headers: authHeader(organiser),
    }).then((r) => r.json() as { data: Array<{ roomId: number }> })).data

    const teams = await query<{ team_id: number }>(
      `INSERT INTO team (display_name, contact_email, origin, created_by) VALUES
         ('One', 'one@example.test', 'ORGANISER', 'fixture'),
         ('Two', 'two@example.test', 'ORGANISER', 'fixture')
       RETURNING team_id`)

    const assign = (teamId: number, roomId: number) => app.inject({
      method: 'PUT', url: `/api/v1/roster/teams/${teamId}/logistics`,
      headers: authHeader(organiser), payload: { roomId },
    })

    expect((await assign(Number(teams.rows[0]!.team_id), rooms[0]!.roomId)).statusCode).toBe(200)
    // A hall seats several teams (migration 096). What used to be a 409 is the intended case.
    expect((await assign(Number(teams.rows[1]!.team_id), rooms[0]!.roomId)).statusCode).toBe(200)
  })

  it('is refused to a reviewer — logistics are an organiser\'s to move', async () => {
    const team = await query<{ team_id: number }>(
      `INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ('One', 'one@example.test', 'ORGANISER', 'fixture') RETURNING team_id`)
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/roster/teams/${team.rows[0]!.team_id}/logistics`,
      headers: authHeader(reviewer), payload: { roomId: 1 },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('assigning and unassigning over HTTP (E28)', () => {
  async function setup(): Promise<{ teamId: number; participantId: number }> {
    await load('participant', PEOPLE, true)
    const team = await query<{ team_id: number }>(
      `INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ('Alpha', 'alpha@example.test', 'ORGANISER', 'fixture') RETURNING team_id`)
    const board = await app.inject({
      method: 'GET', url: '/api/v1/roster/board', headers: authHeader(organiser),
    })
    const data = (board.json() as {
      data: { unassigned: Array<{ participantId: number }> }
    }).data
    return {
      teamId: Number(team.rows[0]!.team_id),
      participantId: data.unassigned[0]!.participantId,
    }
  }

  it('assigns, and the board stops listing them as unassigned', async () => {
    const { teamId, participantId } = await setup()

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/roster/teams/${teamId}/members`,
      headers: authHeader(organiser), payload: { participantId, move: true },
    })
    expect(res.statusCode).toBe(200)

    const board = await app.inject({
      method: 'GET', url: '/api/v1/roster/board', headers: authHeader(organiser),
    })
    expect((board.json() as { data: { unassignedTotal: number } }).data.unassignedTotal).toBe(1)
  })

  it('UNASSIGNS, and they come back to the unassigned list', async () => {
    const { teamId, participantId } = await setup()
    await app.inject({
      method: 'PUT', url: `/api/v1/roster/teams/${teamId}/members`,
      headers: authHeader(organiser), payload: { participantId, move: true },
    })

    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/roster/members/${participantId}`,
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(204)

    const board = await app.inject({
      method: 'GET', url: '/api/v1/roster/board', headers: authHeader(organiser),
    })
    expect((board.json() as { data: { unassignedTotal: number } }).data.unassignedTotal).toBe(2)
  })
})

describe('creating a team over HTTP (E28-S02 acceptance 7)', () => {
  const create = (payload: unknown, user = organiser) => app.inject({
    method: 'POST', url: '/api/v1/roster/teams', headers: authHeader(user), payload,
  })

  it('is refused to a reviewer — the roster is an organiser\'s to build', async () => {
    expect((await create({ displayName: 'Night Shift' }, reviewer)).statusCode).toBe(403)
  })

  it('returns 201 with the team, and 409 naming the clash on a second attempt', async () => {
    const first = await create({ displayName: 'Night Shift' })
    expect(first.statusCode).toBe(201)
    expect((first.json() as { data: { team: { displayName: string } } }).data.team.displayName)
      .toBe('Night Shift')

    // The same team after normalisation, so the second attempt must say which team it is.
    const again = await create({ displayName: 'The Night-Shift' })
    expect(again.statusCode).toBe(409)
    expect((again.json() as { error: { message: string } }).error.message)
      .toMatch(/Night Shift already exists/)
  })

  it('creates the team with its first member in one request', async () => {
    await load('participant', PEOPLE, true)
    const board = await app.inject({
      method: 'GET', url: '/api/v1/roster/board', headers: authHeader(organiser),
    })
    const participantId = (board.json() as {
      data: { unassigned: Array<{ participantId: number }> }
    }).data.unassigned[0]!.participantId

    const res = await create({ displayName: 'Night Shift', participantId })
    expect(res.statusCode).toBe(201)
    const body = (res.json() as { data: { contact: { isContact: boolean } | null } }).data
    expect(body.contact?.isContact).toBe(true)
  })

  it('rejects a name too short to be a team name before reaching the service', async () => {
    expect((await create({ displayName: 'X' })).statusCode).toBe(400)
  })
})

describe('adding records by hand over HTTP (E31)', () => {
  const add = (path: string, payload: unknown, user = organiser) => app.inject({
    method: 'POST', url: `/api/v1/roster/${path}`, headers: authHeader(user), payload,
  })

  it('refuses all three to a reviewer — the roster is an organiser\'s to build', async () => {
    expect((await add('participants', { fullName: 'A B', email: 'a@b.test' }, reviewer))
      .statusCode).toBe(403)
    expect((await add('rooms', { label: 'Ada' }, reviewer)).statusCode).toBe(403)
    expect((await add('coaches', { fullName: 'C D', email: 'c@d.test' }, reviewer))
      .statusCode).toBe(403)
  })

  it('creates a participant, then refuses the same address naming who has it', async () => {
    expect((await add('participants', {
      fullName: 'Ada Lovelace', email: 'ada@example.test',
    })).statusCode).toBe(201)

    const again = await add('participants', { fullName: 'Ada L', email: 'ada@example.test' })
    expect(again.statusCode).toBe(409)
    expect((again.json() as { error: { message: string } }).error.message)
      .toMatch(/Ada Lovelace is already on the roster/)
  })

  it('creates a room and a coach', async () => {
    expect((await add('rooms', { label: 'Ada', location: 'First floor', capacity: 6 }))
      .statusCode).toBe(201)
    expect((await add('coaches', {
      fullName: 'Margaret Hamilton', email: 'margaret@example.test',
    })).statusCode).toBe(201)

    const coaches = await app.inject({
      method: 'GET', url: '/api/v1/roster/coaches', headers: authHeader(organiser),
    })
    expect((coaches.json() as { data: unknown[] }).data).toHaveLength(1)
  })

  it('rejects an address that is not one, before reaching the service', async () => {
    expect((await add('participants', { fullName: 'Ada Lovelace', email: 'not-an-address' }))
      .statusCode).toBe(400)
  })
})

describe('paging, ordering and search over HTTP (E40)', () => {
  const get = (qs: string) => app.inject({
    method: 'GET', url: `/api/v1/roster/participants?${qs}`, headers: authHeader(organiser),
  })
  const names = (res: Awaited<ReturnType<typeof get>>) =>
    (res.json() as { data: { participants: Array<{ fullName: string }> } })
      .data.participants.map((p) => p.fullName)

  it('orders by an allow-listed key', async () => {
    await load('participant', PEOPLE, true)
    expect(await names(await get('sort=name'))).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(await names(await get('sort=email'))).toEqual(['Ada Lovelace', 'Grace Hopper'])
  })

  it('REFUSES a sort key that is not on the list, rather than ignoring it', async () => {
    // Silently defaulting makes a sort that did nothing look exactly like one that worked.
    expect((await get('sort=salary; DROP TABLE participant')).statusCode).toBe(400)
    expect((await get('sort=full_name')).statusCode).toBe(400)
  })

  it('searches on the server across name, address and organisation', async () => {
    // Its own fixture, because PEOPLE carries no organisation and the third case needs one.
    await load('participant',
      'full_name,email,organisation\n'
      + 'Ada Lovelace,ada@example.test,Analytical Engines\n'
      + 'Grace Hopper,grace@example.test,Navy', true)

    expect(await names(await get('search=Lovelace'))).toEqual(['Ada Lovelace'])
    expect(await names(await get('search=grace@'))).toEqual(['Grace Hopper'])
    expect(await names(await get('search=Navy'))).toEqual(['Grace Hopper'])
  })

  it('counts what MATCHES the search, not the whole roster (P5.7)', async () => {
    await load('participant', PEOPLE, true)
    const res = await get('search=Lovelace')
    expect((res.json() as { data: { total: number } }).data.total).toBe(1)
  })

  it('pages without repeating or dropping a row', async () => {
    await load('participant', PEOPLE, true)
    const first = await names(await get('sort=name&pageSize=1&page=1'))
    const second = await names(await get('sort=name&pageSize=1&page=2'))

    expect(first).toEqual(['Ada Lovelace'])
    expect(second).toEqual(['Grace Hopper'])
    expect(first[0]).not.toBe(second[0])
  })
})
