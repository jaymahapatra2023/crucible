/**
 * Handing registered teams their submission code, once, later in the day (migration 103).
 *
 * Registration no longer carries the code, so something has to. What matters here is that it
 * reaches exactly the teams that have registered and not yet been sent it, that running it twice
 * does not mean two emails, and that an unclaimed slot is not treated as a team with a problem.
 *
 * And that it reaches THE TEAM. The first real run of this at the event sent thirty messages to
 * thirty registrants and left eighty-six team members without the code — because the query read
 * `contact_email` and nothing else, and one person per team registers by design. The last tests
 * here are that gap, pinned.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { registerMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { provisionSlots } from '../../src/modules/roster/services/slotService.js'
import { openWindow } from '../../src/modules/submissions/services/windowService.js'
import {
  confirmRegistration, lookupTeammate, startRegistration, verifyLink,
} from '../../src/modules/roster/services/registrationService.js'
import { handOutCodes, setHandoutPacer } from '../../src/modules/submissions/services/codeHandout.js'
import { setNoticePacer } from '../../src/modules/roster/services/registrationNotices.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'handout' }, fn)

const PEOPLE = ['full_name,email',
  'Ada Lovelace,ada@example.test',
  'Grace Hopper,grace@example.test',
  'Alan Turing,alan@example.test',
  'Katherine Johnson,katherine@example.test',
  'Barbara Liskov,barbara@example.test',
  'Edsger Dijkstra,edsger@example.test'].join('\n')
const ROOMS = ['label,location,capacity,teams', 'Hall A,First floor,40,4'].join('\n')
const COACHES = ['name,email,teams', 'Margaret Hamilton,margaret@example.test,2'].join('\n')
const SLOTS = ['label,room,coach',
  'Team 1,Hall A,Margaret Hamilton',
  'Team 2,Hall A,Margaret Hamilton'].join('\n')

let sent: MailMessage[]

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  setHandoutPacer(async () => {})
  setNoticePacer(async () => {})
  sent = []
  registerMailProvider({
    name: 'fake', sends: true,
    async send(m) { sent.push(m); return { delivered: true, detail: 'sent', providerRef: 'x' } },
  })
  // The deadline in the code email is read from the window the system enforces, never typed in.
  await inScope(() => openWindow({
    name: 'Entries', opensAt: new Date(Date.now() - 3600_000),
    closesAt: new Date('2026-10-04T13:00:00Z'), actor: ACTOR,
  }))
  for (const [kind, csv] of [['participant', PEOPLE], ['room', ROOMS], ['coach', COACHES]] as const) {
    await inScope(() => importRoster({ kind, csv, confirm: true, actor: ACTOR }))
  }
  await inScope(() => provisionSlots({ csv: SLOTS, confirm: true, actor: ACTOR }))
  await setConfig('event.submit_url', 'https://crucible.example/submit', ACTOR)
  invalidateConfig()
})

async function register(name: string, registrant: string, mates: readonly string[]) {
  await inScope(() => startRegistration({ email: registrant }))
  const link = /crr_[A-Za-z0-9_-]+/.exec(sent[sent.length - 1]!.body)![0]
  const scope = await verifyLink(link)
  const ids: number[] = []
  for (const mate of mates) {
    ids.push((await inScope(() => lookupTeammate(scope, mate))).participantId!)
  }
  return inScope(() => confirmRegistration({ scope, displayName: name, teammateIds: ids }))
}

describe('handing out the codes', () => {
  it('reports a registered team as WAITING, and sends nothing without confirm', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    sent.length = 0

    const plan = await inScope(() => handOutCodes({ confirm: false, actor: ACTOR }))
    expect(plan.summary).toEqual({ total: 1, waiting: 1, alreadySent: 0, blocked: 0 })
    expect(plan.rows[0]).toMatchObject({ teamName: 'Night Shift', state: 'WAITING' })
    expect(plan.report).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('sends the code, with the deadline and where to submit', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    sent.length = 0

    const plan = await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    expect(plan.report?.outcomes[0]).toMatchObject({ teamName: 'Night Shift', status: 'SENT' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatch(/crs_/)
    expect(sent[0]!.body).toContain('https://crucible.example/submit')
    expect(sent[0]!.body).toContain('Sunday, 4 October 2026 at 09:00 (Eastern)')
  })

  it('does NOT send twice — running it again reports the team as already sent', async () => {
    // The organiser will press this, be interrupted, and press it again.
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    sent.length = 0

    const again = await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    expect(again.summary).toEqual({ total: 1, waiting: 0, alreadySent: 1, blocked: 0 })
    expect(sent).toHaveLength(0)
  })

  it('sends only to the LATE team when one registers after the first handout', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))

    await register('Day Shift', 'katherine@example.test',
      ['barbara@example.test', 'edsger@example.test'])
    sent.length = 0

    const plan = await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    expect(plan.summary).toMatchObject({ total: 2, alreadySent: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('katherine@example.test')
  })

  it('ignores unclaimed slots entirely — a label on a door is not a team', async () => {
    // Two slots were provisioned and neither has been claimed. They hold no code, so they fall
    // out rather than arriving as rows an organiser has to read past.
    const plan = await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    expect(plan.summary).toEqual({ total: 0, waiting: 0, alreadySent: 0, blocked: 0 })
    expect(sent).toHaveLength(0)
  })

  it('includes a team that registered after the slots ran out', async () => {
    // Both slots are taken, so the third registration creates a team with no slot at all. That
    // case is designed for, and keying this on the slot claim would have left exactly those
    // teams never sent their code.
    await register('One', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await register('Two', 'katherine@example.test', ['barbara@example.test', 'edsger@example.test'])
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))

    await inScope(() => importRoster({
      kind: 'participant',
      csv: ['full_name,email', 'Ida A,ida@example.test', 'Jean B,jean@example.test',
        'Ken T,ken@example.test'].join('\n'),
      confirm: true, actor: ACTOR,
    }))
    const late = await register('Spillover', 'ida@example.test',
      ['jean@example.test', 'ken@example.test'])
    const unplaced = await query<{ slot_label: string | null }>(
      'SELECT slot_label FROM team WHERE team_id = $1', [late.teamId])
    expect(unplaced.rows[0]!.slot_label).toBeNull()

    sent.length = 0
    const plan = await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    expect(plan.summary).toMatchObject({ total: 3, alreadySent: 2 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('ida@example.test')
  })

  it('records the handout in the audit trail without a code or an address', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))

    const audit = await query<{ payload: unknown }>(
      "SELECT payload FROM audit_event WHERE action = 'submissions.codes_handed_out'")
    expect(audit.rows).toHaveLength(1)
    const text = JSON.stringify(audit.rows[0]!.payload)
    expect(text).toMatch(/"teams":1/)
    expect(text).not.toMatch(/crs_/)
    expect(text).not.toMatch(/@/)
  })

  it('copies EVERY teammate on the one message — the code belongs to the team', async () => {
    // The gap that mattered at the event: one registrant per team by design, so addressing
    // `contact_email` alone made a team's ability to submit depend on one person reading mail.
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    sent.length = 0

    const plan = await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    expect(plan.rows[0]).toMatchObject({ copiedTo: 2 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('ada@example.test')
    expect([...sent[0]!.copyTo ?? []].sort())
      .toEqual(['alan@example.test', 'grace@example.test'])
  })

  it('counts PEOPLE in the audit trail, not just teams', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))

    const audit = await query<{ payload: { teams: number; recipients: number } }>(
      "SELECT payload FROM audit_event WHERE action = 'submissions.codes_handed_out'")
    // One team, three people. A trail that only recorded "teams: 1" is what let this pass
    // unnoticed for a whole send.
    expect(audit.rows[0]!.payload).toMatchObject({ teams: 1, recipients: 3 })
  })

  it('does not copy a teammate who has been removed from the roster', async () => {
    // Somebody leaves mid-event and is taken off the roster. Their address must stop receiving
    // the team's credential — and the rest of the team must still get it.
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await query(`UPDATE participant
                    SET deleted_at = now(), deleted_by = $1, delete_reason = 'ADMIN_ACTION'
                  WHERE email = 'alan@example.test'`, [ACTOR])
    sent.length = 0

    const plan = await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    expect(plan.rows[0]).toMatchObject({ copiedTo: 1 })
    expect(sent[0]!.copyTo).toEqual(['grace@example.test'])
  })

  it('RE-SENDS to a team already sent when asked, so a short send can be put right', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    sent.length = 0

    const plan = await inScope(() => handOutCodes({ confirm: true, resend: true, actor: ACTOR }))
    expect(plan.summary).toMatchObject({ waiting: 1, alreadySent: 0 })
    expect(plan.rows[0]!.detail).toMatch(/sent again with 2 teammates copied/)
    expect(sent).toHaveLength(1)
    expect([...sent[0]!.copyTo ?? []].sort())
      .toEqual(['alan@example.test', 'grace@example.test'])
  })

  it('gives a re-send its OWN idempotency key, or Discord would discard it as a duplicate', async () => {
    await register('Night Shift', 'ada@example.test', ['grace@example.test', 'alan@example.test'])
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))
    const first = sent[sent.length - 1]!.idempotencyKey

    await inScope(() => handOutCodes({ confirm: true, resend: true, actor: ACTOR }))
    const second = sent[sent.length - 1]!.idempotencyKey
    expect(second).not.toBe(first)

    // But FIXED, not a timestamp: asking for the same correction twice is still one message.
    await inScope(() => handOutCodes({ confirm: true, resend: true, actor: ACTOR }))
    expect(sent[sent.length - 1]!.idempotencyKey).toBe(second)
  })
})
