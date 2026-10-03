/**
 * The public registration contract (E44, P8.1, E48-S03).
 *
 * The property this file exists to hold: no public route returns a list of participants or
 * teams. A registration is scoped by its link, and the link resolves to one person.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { closeApp, getApp } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { registerMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

let app: FastifyInstance
let sent: MailMessage[]

const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'reg-api' }, fn)

const PEOPLE = 'full_name,email\nAda Lovelace,ada@example.test\nGrace Hopper,grace@example.test\nAlan Turing,alan@example.test'

const start = (email: string) => app.inject({
  method: 'POST', url: '/api/v1/register/start', payload: { email },
})

async function link(): Promise<string> {
  await start('ada@example.test')
  const m = /crr_[A-Za-z0-9_-]+/.exec(sent[sent.length - 1]?.body ?? '')
  if (!m) throw new Error('no link sent')
  return m[0]
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  app = await getApp()
  sent = []
  registerMailProvider({
    name: 'fake', sends: true,
    async send(m) { sent.push(m); return { delivered: true, detail: 'ok' } },
  })
  await inScope(() => importRoster({ kind: 'participant', csv: PEOPLE, confirm: true, actor: 'o@test.local' }))
  await query(`INSERT INTO challenge (name, slug, status, created_by)
               VALUES ('Open Challenge', 'open-challenge', 'OPEN', 'fixture')`)
})

afterAll(async () => closeApp())

describe('public without an account (P8.1)', () => {
  it('accepts a start with no credential of any kind', async () => {
    expect((await start('ada@example.test')).statusCode).toBe(200)
  })

  it('validates the address shape before reaching the roster', async () => {
    expect((await start('not-an-address')).statusCode).toBe(400)
  })

  it('refuses an unknown link with 401, not 404 — nothing to enumerate', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/register/crr_nope' })
    expect(res.statusCode).toBe(401)
  })
})

describe('no public route lists anybody (II.1, E48-S03)', () => {
  it('a link resolves to ONE name and nothing else — no participant array, no challenge list', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/register/${await link()}` })
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: Record<string, unknown> }).data

    expect(data['registrantName']).toBe('Ada Lovelace')
    // No 'challenges' either: the challenge moved to the submission form, so the scope has no
    // reason to carry it and a public response should not hold data nothing reads.
    expect(Object.keys(data).sort()).toEqual(['bounds', 'discord', 'expiresAt', 'registrantName'])
    expect(JSON.stringify(data)).not.toContain('Grace')
    expect(JSON.stringify(data)).not.toContain('@example.test')
  })

  it('lookup returns at most one name, for an exact address', async () => {
    const l = await link()
    const hit = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/lookup`, payload: { email: 'grace@example.test' },
    })
    expect((hit.json() as { data: { found: boolean; fullName?: string } }).data)
      .toMatchObject({ found: true, fullName: 'Grace Hopper' })

    const miss = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/lookup`, payload: { email: 'gra@example.test' },
    })
    expect((miss.json() as { data: { found: boolean } }).data.found).toBe(false)
  })

  it('the participant and team lists stay behind authentication', async () => {
    for (const url of ['/api/v1/roster/participants', '/api/v1/submissions/teams', '/api/v1/roster/board']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }
  })
})

describe('the whole journey over HTTP', () => {
  it('registers a team and confirms the code was SENT without returning it', async () => {
    const l = await link()
    const ids: number[] = []
    for (const email of ['grace@example.test', 'alan@example.test']) {
      const r = await app.inject({ method: 'POST', url: `/api/v1/register/${l}/lookup`, payload: { email } })
      ids.push((r.json() as { data: { participantId: number } }).data.participantId)
    }
    const name = await app.inject({ method: 'GET', url: `/api/v1/register/${l}/name?name=Night%20Shift` })
    expect((name.json() as { data: { ok: boolean } }).data.ok).toBe(true)

    const res = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/confirm`,
      payload: { displayName: 'Night Shift', teammateIds: ids },
    })
    expect(res.statusCode).toBe(201)
    const data = (res.json() as { data: { tokenEmailed: boolean; memberCount: number } }).data
    expect(data).toMatchObject({ tokenEmailed: true, memberCount: 3 })
    expect(res.body).not.toMatch(/crs_/)

    // And the link is spent.
    expect((await app.inject({ method: 'GET', url: `/api/v1/register/${l}` })).statusCode).toBe(412)
  })

  it('accepts a Discord username per teammate, and reports which could not be used', async () => {
    // No bot is configured in this suite, so nothing resolves — which is the point: the route
    // must still accept the field, register the team, and SAY that email will be used.
    const l = await link()
    const ids: number[] = []
    for (const email of ['grace@example.test', 'alan@example.test']) {
      const r = await app.inject({ method: 'POST', url: `/api/v1/register/${l}/lookup`, payload: { email } })
      ids.push((r.json() as { data: { participantId: number } }).data.participantId)
    }
    const res = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/confirm`,
      payload: {
        displayName: 'Night Shift', teammateIds: ids,
        teammateDiscord: [{ participantId: ids[0], username: 'grace_h' }],
      },
    })
    expect(res.statusCode).toBe(201)
    const data = (res.json() as { data: { memberDiscordNotes: string[] } }).data
    expect(data.memberDiscordNotes).toHaveLength(1)
    expect(data.memberDiscordNotes[0]).toMatch(/not configured/)
  })

  it('refuses a malformed teammateDiscord entry rather than ignoring it', async () => {
    const l = await link()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/confirm`,
      payload: {
        displayName: 'Night Shift', teammateIds: [],
        teammateDiscord: [{ participantId: 'not-a-number', username: 'x' }],
      },
    })
    // 400, not 422: a participant id that is not a number is a malformed request, not a team
    // the rules reject. The shape is refused before any rule is consulted.
    expect(res.statusCode).toBe(400)
  })

  it('refuses a two-person team with the rule in the message', async () => {
    const l = await link()
    const r = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/lookup`, payload: { email: 'grace@example.test' },
    })
    const id = (r.json() as { data: { participantId: number } }).data.participantId
    const res = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/confirm`,
      payload: { displayName: 'Pair', teammateIds: [id] },
    })
    expect(res.statusCode).toBe(422)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/between 3 and 8/)
  })
})

describe('the Discord identity, at the public edge (E49-S02)', () => {
  it('the link says whether Discord can be used, and a check answers plainly when it cannot', async () => {
    const l = await link()
    const scope = await app.inject({ method: 'GET', url: `/api/v1/register/${l}` })
    // No bot is configured in tests, so the form must not ask for what cannot be used.
    expect(scope.json<{ data: { discord: { enabled: boolean } } }>().data.discord.enabled).toBe(false)

    const check = await app.inject({
      method: 'POST', url: `/api/v1/register/${l}/discord`, payload: { username: 'ada_dev' },
    })
    expect(check.statusCode).toBe(200)
    expect(check.json<{ data: { found: boolean; message: string } }>().data)
      .toMatchObject({ found: false, message: expect.stringMatching(/not configured/) })
  })

  it('is public, but only inside a link — an unknown link is refused', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/register/crr_nope/discord', payload: { username: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })
})
