/**
 * Pre-provisioned team slots (migrations 095–097).
 *
 * The organisers want the floor plan to exist before anyone arrives — "Team 7 — Hall A — coach
 * Margaret", printed and taped to a door — and a registering team to take the next free slot and
 * inherit its room and coach with nobody matching teams to rooms on the day.
 *
 * Four things here would each break the morning if they were wrong: the claim must be safe when
 * two teams confirm at once, it must degrade rather than refuse when the pool runs dry, it must
 * not let a slot label block a team that wants the same name, and the coach must not be sent the
 * team's submission code.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { registerMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { provisionSlots, slotStatus } from '../../src/modules/roster/services/slotService.js'
import { listSlots } from '../../src/modules/roster/db/slotDb.js'
import {
  checkTeamName, confirmRegistration, lookupTeammate, startRegistration, verifyLink,
} from '../../src/modules/roster/services/registrationService.js'
import { openWindow } from '../../src/modules/submissions/services/windowService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'slots' }, fn)

const PEOPLE = [
  'full_name,email',
  'Ada Lovelace,ada@example.test',
  'Grace Hopper,grace@example.test',
  'Alan Turing,alan@example.test',
  'Katherine Johnson,katherine@example.test',
  'Barbara Liskov,barbara@example.test',
  'Edsger Dijkstra,edsger@example.test',
].join('\n')

const ROOMS = ['label,location,capacity,teams', 'Hall A,First floor,40,4', 'Hall B,Second floor,24,2']
  .join('\n')
const COACHES = ['name,email,teams',
  'Margaret Hamilton,margaret@example.test,2',
  'Katherine J,kj@example.test,1'].join('\n')
const SLOTS = [
  'label,room,coach',
  'Team 1,Hall A,Margaret Hamilton',
  'Team 2,Hall A,Margaret Hamilton',
  'Team 3,Hall B,Katherine J',
].join('\n')

let sent: MailMessage[]

const linkFrom = (m: MailMessage): string => {
  const match = /crr_[A-Za-z0-9_-]+/.exec(m.body)
  if (!match) throw new Error('no link in message')
  return match[0]
}

async function linkFor(email: string) {
  const outcome = await inScope(() => startRegistration({ email }))
  expect(outcome.status).toBe('SENT')
  return verifyLink(linkFrom(sent[sent.length - 1]!))
}

/** Register a team of three from the given registrant and two teammates. */
async function register(name: string, registrant: string, mates: readonly string[]) {
  const scope = await linkFor(registrant)
  const ids: number[] = []
  for (const mate of mates) {
    const found = await inScope(() => lookupTeammate(scope, mate))
    ids.push(found.participantId!)
  }
  return inScope(() => confirmRegistration({ scope, displayName: name, teammateIds: ids }))
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  sent = []
  registerMailProvider({
    name: 'fake', sends: true,
    async send(m) { sent.push(m); return { delivered: true, detail: 'ok', providerRef: 'x' } },
  })
  await inScope(() => openWindow({
    name: 'Entries', opensAt: new Date(Date.now() - 3600_000),
    closesAt: new Date('2026-10-04T13:00:00Z'), actor: ACTOR,
  }))
  for (const [kind, csv] of [['participant', PEOPLE], ['room', ROOMS], ['coach', COACHES]] as const) {
    await inScope(() => importRoster({ kind, csv, confirm: true, actor: ACTOR }))
  }
})

describe('provisioning the floor plan', () => {
  it('says what the file would do before writing anything', async () => {
    const plan = await inScope(() => provisionSlots({ csv: SLOTS, confirm: false, actor: ACTOR }))

    expect(plan.provisioned).toBe(false)
    expect(plan.summary).toEqual({ total: 3, new: 3, existing: 0, invalid: 0 })
    expect((await slotStatus()).total).toBe(0)
  })

  it('reports how many slots land in each room, against BOTH of its limits', async () => {
    // Several teams per room is the intended arrangement (migration 096). The number that says
    // whether it fits is the TEAM limit, not the seat count (migration 101).
    const plan = await inScope(() => provisionSlots({ csv: SLOTS, confirm: false, actor: ACTOR }))
    expect(plan.roomLoad).toEqual([
      { room: 'Hall A', slots: 2, capacity: 40, teamCapacity: 4, overTeamCapacity: false },
      { room: 'Hall B', slots: 1, capacity: 24, teamCapacity: 2, overTeamCapacity: false },
    ])
  })

  it('reports each coach\'s load against the number they agreed to take', async () => {
    const plan = await inScope(() => provisionSlots({ csv: SLOTS, confirm: false, actor: ACTOR }))
    // Margaret agreed to 2 and has 2; Katherine agreed to 1 and has 1. Nothing to act on.
    expect(plan.coachLoad).toEqual([
      { coach: 'Margaret Hamilton', slots: 2, teamCapacity: 2, overTeamCapacity: false },
      { coach: 'Katherine J', slots: 1, teamCapacity: 1, overTeamCapacity: false },
    ])
  })

  it('flags a coach given more teams than they agreed to, and still provisions', async () => {
    // Advisory. The coach who finds out on the day is the wrong person to discover it, but an
    // organiser deliberately stretching a willing coach is not an error either.
    const crowded = ['label,room,coach',
      'Team 1,Hall A,Katherine J',
      'Team 2,Hall A,Katherine J'].join('\n')
    const plan = await inScope(() => provisionSlots({ csv: crowded, confirm: false, actor: ACTOR }))
    expect(plan.coachLoad).toEqual([
      { coach: 'Katherine J', slots: 2, teamCapacity: 1, overTeamCapacity: true },
    ])
    expect(plan.refusal).toBeNull()

    const done = await inScope(() => provisionSlots({ csv: crowded, confirm: true, actor: ACTOR }))
    expect(done.provisioned).toBe(true)
  })

  it('flags a room given more slots than it holds TEAMS, and still provisions it', async () => {
    // Advisory, not a refusal. An organiser crowding a room at 11pm because another lost power
    // is making the right call; the system's job is to say so, not to block it.
    const crowded = ['label,room,coach',
      'Team 1,Hall B,Margaret Hamilton',
      'Team 2,Hall B,Margaret Hamilton',
      'Team 3,Hall B,Margaret Hamilton'].join('\n')
    const plan = await inScope(() => provisionSlots({ csv: crowded, confirm: false, actor: ACTOR }))
    expect(plan.roomLoad).toEqual([
      { room: 'Hall B', slots: 3, capacity: 24, teamCapacity: 2, overTeamCapacity: true },
    ])
    expect(plan.refusal).toBeNull()

    const done = await inScope(() => provisionSlots({ csv: crowded, confirm: true, actor: ACTOR }))
    expect(done.provisioned).toBe(true)
    expect(done.summary.new).toBe(3)
  })

  it('says nothing about a limit the room does not have', async () => {
    // A room whose team figure nobody worked out is a real state, not a zero.
    await inScope(() => importRoster({
      kind: 'room', csv: 'label,location,capacity\nHall C,Third floor,30', confirm: true, actor: ACTOR,
    }))
    const plan = await inScope(() => provisionSlots({
      csv: 'label,room,coach\nTeam 9,Hall C,Margaret Hamilton', confirm: false, actor: ACTOR,
    }))
    expect(plan.roomLoad).toEqual([
      { room: 'Hall C', slots: 1, capacity: 30, teamCapacity: null, overTeamCapacity: false },
    ])
  })

  it('provisions each slot with its room and coach', async () => {
    await inScope(() => provisionSlots({ csv: SLOTS, confirm: true, actor: ACTOR }))

    const slots = await listSlots()
    expect(slots.map((s) => [s.slot_label, s.room_label, s.coach_name])).toEqual([
      ['Team 1', 'Hall A', 'Margaret Hamilton'],
      ['Team 2', 'Hall A', 'Margaret Hamilton'],
      ['Team 3', 'Hall B', 'Katherine J'],
    ])
    expect(await slotStatus()).toMatchObject({ total: 3, available: 3, claimed: 0 })
  })

  it('refuses the WHOLE file when a row names something that does not exist', async () => {
    const bad = `${SLOTS}\nTeam 4,Hall Z,Margaret Hamilton`
    const plan = await inScope(() => provisionSlots({ csv: bad, confirm: true, actor: ACTOR }))

    expect(plan.provisioned).toBe(false)
    expect(plan.refusal).toMatch(/Nothing was provisioned/)
    expect(plan.rows.at(-1)?.detail).toMatch(/No room called "Hall Z"/)
    // Half a floor plan is worse than none: an organiser cannot tell which half.
    expect((await slotStatus()).total).toBe(0)
  })

  it('is idempotent, so a second file adding slots leaves the first alone', async () => {
    await inScope(() => provisionSlots({ csv: SLOTS, confirm: true, actor: ACTOR }))
    const more = ['label,room,coach', 'Team 1,Hall A,Margaret Hamilton', 'Team 4,Hall B,Katherine J'].join('\n')

    const plan = await inScope(() => provisionSlots({ csv: more, confirm: true, actor: ACTOR }))

    expect(plan.summary).toMatchObject({ existing: 1, new: 1 })
    expect(plan.rows[0]?.detail).toMatch(/Already provisioned and still free/)
    expect((await slotStatus()).total).toBe(4)
  })

  it('refuses a file that names the same slot twice', async () => {
    const dup = ['label,room,coach', 'Team 1,Hall A,', 'Team 1,Hall B,'].join('\n')
    const plan = await inScope(() => provisionSlots({ csv: dup, confirm: true, actor: ACTOR }))
    expect(plan.rows[1]?.detail).toMatch(/appears more than once/)
    expect(plan.provisioned).toBe(false)
  })
})

describe('claiming a slot', () => {
  beforeEach(async () => {
    await inScope(() => provisionSlots({ csv: SLOTS, confirm: true, actor: ACTOR }))
  })

  it('takes the first free slot and inherits its room and coach', async () => {
    const outcome = await register('Night Shift', 'ada@example.test',
      ['grace@example.test', 'alan@example.test'])

    const slots = await listSlots()
    const claimed = slots.find((s) => s.slot_label === 'Team 1')
    expect(claimed?.display_name).toBe('Night Shift')
    expect(claimed?.available).toBe(false)
    expect(claimed?.room_label).toBe('Hall A')
    expect(claimed?.coach_name).toBe('Margaret Hamilton')
    expect(claimed?.team_id).toBe(outcome.teamId)
  })

  it('keeps the slot label after the claim, because the printed sign still says it', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    const row = await query<{ slot_label: string; display_name: string }>(
      'SELECT slot_label, display_name FROM team WHERE slot_label = $1', ['Team 1'])
    expect(row.rows[0]).toEqual({ slot_label: 'Team 1', display_name: 'Night Shift' })
  })

  it('gives two simultaneous registrations DIFFERENT slots', async () => {
    // The claim locks the row it takes and skips locked ones. Without that, both reads see the
    // same free slot and one team silently overwrites the other's placement.
    const first = await linkFor('ada@example.test')
    const second = await linkFor('barbara@example.test')
    const matesA = await Promise.all(['grace@example.test', 'alan@example.test']
      .map((m) => inScope(() => lookupTeammate(first, m))))
    const matesB = await Promise.all(['katherine@example.test', 'edsger@example.test']
      .map((m) => inScope(() => lookupTeammate(second, m))))

    const [a, b] = await Promise.all([
      inScope(() => confirmRegistration({
        scope: first, displayName: 'Night Shift', teammateIds: matesA.map((m) => m.participantId!),
      })),
      inScope(() => confirmRegistration({
        scope: second, displayName: 'Day Shift', teammateIds: matesB.map((m) => m.participantId!),
      })),
    ])

    expect(a.teamId).not.toBe(b.teamId)
    const claimed = (await listSlots()).filter((s) => !s.available)
    expect(claimed).toHaveLength(2)
    expect(new Set(claimed.map((s) => s.slot_label)).size).toBe(2)
  })

  it('still registers when the pool is EXHAUSTED, leaving the team unplaced', async () => {
    // Forty slots and sixty teams is a real possibility. Refusing the forty-first registration
    // would be the worst failure available; an unplaced team is a line on a readiness panel.
    await query('UPDATE team SET claimed_at = now() WHERE slot_label IS NOT NULL')

    const outcome = await register('Latecomers', 'ada@example.test',
      ['grace@example.test', 'alan@example.test'])

    expect(outcome.teamId).toBeGreaterThan(0)
    const row = await query<{ slot_label: string | null }>(
      'SELECT slot_label FROM team WHERE team_id = $1', [outcome.teamId])
    expect(row.rows[0]?.slot_label).toBeNull()
  })

  it('does not let an unclaimed slot label block a team that wants that name', async () => {
    // "Team 7" is a sign on a door, not a team anybody has.
    expect(await checkTeamName('Team 2')).toMatchObject({ ok: true })

    const outcome = await register('Team 2', 'ada@example.test',
      ['grace@example.test', 'alan@example.test'])
    expect(outcome.displayName).toBe('Team 2')

    // Once claimed by a real team, the name IS taken.
    expect(await checkTeamName('Team 2')).toMatchObject({ ok: false })
  })
})

describe('who is told, and what they are told', () => {
  beforeEach(async () => {
    await inScope(() => provisionSlots({ csv: SLOTS, confirm: true, actor: ACTOR }))
    sent = []
  })

  it('sends ONE registration email to the whole team, with no code in it', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])

    // One message, not three. A team of eight was eight identical emails, and at forty-eight
    // teams that is several hundred through a relay with a daily cap.
    const teamMails = sent.filter((m) => m.subject.includes('Night Shift is registered'))
    expect(teamMails).toHaveLength(1)
    expect(teamMails[0]!.to).toBe('ada@example.test')
    expect([...(teamMails[0]!.copyTo ?? [])].sort())
      .toEqual(['alan@example.test', 'grace@example.test'])

    // NO code anywhere in it (migration 103). A code emailed at registration sits in ninety-nine
    // inboxes all day before anybody needs it.
    for (const m of sent) expect(m.body).not.toMatch(/crs_/)
  })

  it('tells the team where to sit and who their coach is', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    const body = sent.find((m) => m.subject.includes('Night Shift is registered'))!.body

    expect(body).toContain('Hall A')            // room
    expect(body).toContain('First floor')       // floor: a room number alone is a wander
    expect(body).toContain('Margaret Hamilton') // coach
    expect(body).toContain('Ada Lovelace')      // who is on the team
    expect(body).toContain('Grace Hopper')
    // And says the code is coming, so nobody waits for something they already had.
    expect(body).toMatch(/submission code will be sent/i)
  })

  it('says nothing about submitting, or when, in the registration email', async () => {
    // Asked for explicitly: no submission details at registration, timing included.
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    const body = sent.find((m) => m.subject.includes('Night Shift is registered'))!.body
    expect(body).not.toMatch(/Sunday, 4 October/)
    expect(body).not.toMatch(/crs_/)
    expect(body).not.toMatch(/paste the code/i)
  })

  it('tells the coach the team, the people, the room AND the floor — and never the code', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])

    const coachMail = sent.find((m) => m.to === 'margaret@example.test')
    expect(coachMail).toBeDefined()
    // The code is the team's identity (E17-S01). A coach who holds it can submit as the team.
    expect(coachMail!.body).not.toMatch(/crs_/)
    expect(coachMail!.body).toContain('Night Shift')
    expect(coachMail!.body).toContain('Hall A')
    expect(coachMail!.body).toContain('First floor')
    expect(coachMail!.body).toContain('Ada Lovelace')
    expect(coachMail!.subject).toContain('First floor')
  })

  it('sends the SAME number of emails whether the team has three members or six', async () => {
    // The property that matters at scale. The old shape was one email per member, so forty-eight
    // teams of eight was several hundred messages and a relay with a daily cap refused the tail
    // of them. One per team makes the volume a function of teams, not of headcount.
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    const first = sent.filter((m) => m.subject.includes('is registered')).length

    sent.length = 0
    await register('Day Shift', 'katherine@example.test',
      ['barbara@example.test', 'edsger@example.test'])
    const second = sent.filter((m) => m.subject.includes('is registered')).length

    expect(first).toBe(1)
    expect(second).toBe(1)
  })

  it('tells the COACH the deadline, read from the window rather than written in', async () => {
    // The deadline belongs where submitting is discussed. The team hears it with their code.
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    const coachMail = sent.find((m) => m.to === 'margaret@example.test')!
    expect(coachMail.body).toContain('Sunday, 4 October 2026 at 09:00 (Eastern)')
  })

  it('registers successfully even when a member cannot be emailed', async () => {
    // The team exists and can see so on screen. Failing the registration afterwards because a
    // relay was slow would undo work they have already been told succeeded.
    let calls = 0
    registerMailProvider({
      name: 'flaky', sends: true,
      async send(m) {
        calls += 1
        if (calls > 2) throw new Error('relay refused')
        sent.push(m)
        return { delivered: true, detail: 'ok' }
      },
    })

    const outcome = await register('Night Shift', 'ada@example.test',
      ['grace@example.test', 'alan@example.test'])
    expect(outcome.teamId).toBeGreaterThan(0)
  })

  it('says nothing to a coach when the team is unplaced', async () => {
    await query('UPDATE team SET claimed_at = now() WHERE slot_label IS NOT NULL')
    sent = []

    await register('Latecomers', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    expect(sent.some((m) => m.to === 'margaret@example.test')).toBe(false)
  })
})
