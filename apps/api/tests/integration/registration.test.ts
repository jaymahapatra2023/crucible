/**
 * Participants register their own teams (E44).
 *
 * What is tested is what makes a public endpoint safe to expose: that proof of an address on the
 * roster is the whole authentication, that nothing lists anybody, that a link is single-use even
 * under a race, and that confirmation is one transaction — a losing confirm leaves no team behind.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { registerMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { RECORDING_PROVIDER } from '../../src/modules/submissions/services/mailProviders.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import {
  checkTeamName, confirmRegistration, lookupTeammate, startRegistration, verifyLink,
} from '../../src/modules/roster/services/registrationService.js'
import { setLogLevel, setLogSink } from '../../src/lib/logger.js'
import {
  handOutCodes, setHandoutPacer,
} from '../../src/modules/submissions/services/codeHandout.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'register' }, fn)

const PEOPLE = [
  'full_name,email',
  'Ada Lovelace,ada@example.test',
  'Grace Hopper,grace@example.test',
  'Alan Turing,alan@example.test',
  'Katherine Johnson,katherine@example.test',
].join('\n')

let sent: MailMessage[]

function sendingProvider() {
  sent = []
  registerMailProvider({
    name: 'fake', sends: true,
    async send(m) { sent.push(m); return { delivered: true, detail: 'ok', providerRef: 'x' } },
  })
}

const linkFrom = (m: MailMessage): string => {
  const match = /crr_[A-Za-z0-9_-]+/.exec(m.body)
  if (!match) throw new Error('no link in message')
  return match[0]
}

async function openChallenge(name = 'Registration Challenge'): Promise<number> {
  const row = await query<{ challenge_id: number }>(
    `INSERT INTO challenge (name, slug, status, created_by)
     VALUES ($1, $2, 'OPEN', 'fixture') RETURNING challenge_id`,
    [name, name.toLowerCase().replace(/\s+/g, '-')])
  return Number(row.rows[0]!.challenge_id)
}

/** Start for Ada and return her link scope. */
async function adaLink() {
  const outcome = await inScope(() => startRegistration({ email: 'ada@example.test' }))
  expect(outcome.status).toBe('SENT')
  return verifyLink(linkFrom(sent[sent.length - 1]!))
}

beforeEach(async () => {
  setHandoutPacer(async () => {})
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  sendingProvider()
  await inScope(() => importRoster({ kind: 'participant', csv: PEOPLE, confirm: true, actor: ACTOR }))
})

describe('starting (E44-S01)', () => {
  it('emails a link to an address on the roster, and returns nothing about the roster', async () => {
    const outcome = await inScope(() => startRegistration({ email: 'ada@example.test' }))

    expect(outcome.status).toBe('SENT')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('ada@example.test')
    expect(sent[0]?.body).toMatch(/crr_/)
    // The response carries a sentence, never the link.
    expect(JSON.stringify(outcome)).not.toMatch(/crr_/)
  })

  it('says plainly when the address is not on the roster, and sends nothing (II.3)', async () => {
    const outcome = await inScope(() => startRegistration({ email: 'nobody@example.test' }))
    expect(outcome.status).toBe('NOT_ON_ROSTER')
    expect(outcome.message).toMatch(/not on the participant list/)
    expect(sent).toHaveLength(0)
  })

  it('names the team when the participant is already on one', async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))

    const again = await inScope(() => startRegistration({ email: 'grace@example.test' }))
    expect(again.status).toBe('ALREADY_ON_TEAM')
    expect(again.teamName).toBe('Night Shift')
  })

  it('starting again invalidates the first link (acceptance 6)', async () => {
    await inScope(() => startRegistration({ email: 'ada@example.test' }))
    const first = linkFrom(sent[0]!)
    await inScope(() => startRegistration({ email: 'ada@example.test' }))
    const second = linkFrom(sent[1]!)

    await expect(verifyLink(first)).rejects.toThrow(/newer registration link/)
    await expect(verifyLink(second)).resolves.toMatchObject({ registrantName: 'Ada Lovelace' })
  })

  it('writes no participant data to any log line (acceptance 7)', async () => {
    const lines: string[] = []
    setLogLevel('info')
    setLogSink((l) => { lines.push(JSON.stringify(l)) })
    try {
      await inScope(() => startRegistration({ email: 'ada@example.test' }))
      const all = lines.join('\n')
      expect(lines.length).toBeGreaterThan(0)
      expect(all).not.toContain('ada@example.test')
      expect(all).not.toContain('Ada Lovelace')
      expect(all).not.toMatch(/crr_/)
    } finally {
      setLogSink(null)
      setLogLevel('error')
    }
  })

  it('still reports SENT-or-not honestly when the mailer fails', async () => {
    registerMailProvider({
      name: 'broken', sends: true, async send() { throw new Error('down') },
    })
    const outcome = await inScope(() => startRegistration({ email: 'ada@example.test' }))
    expect(outcome.status).toBe('MAIL_FAILED')
    expect(outcome.message).toMatch(/could not be (sent|emailed)/)
  })
})

describe('the link (E44-S02)', () => {
  it('refuses a link that has expired', async () => {
    await setConfig('registration.link_ttl_minutes', 1, ACTOR)
    invalidateConfig()
    await inScope(() => startRegistration({ email: 'ada@example.test' }))
    const link = linkFrom(sent[0]!)
    await query(`UPDATE registration_link SET expires_at = now() - interval '1 minute'`)

    await expect(verifyLink(link)).rejects.toThrow(/expired/)
  })

  it('refuses anything that is not a registration link, including a submission token', async () => {
    await expect(verifyLink('crs_definitely-a-submission-token')).rejects.toThrow(/not a registration link/)
    await expect(verifyLink('crr_never-issued')).rejects.toThrow(/not recognised/)
  })

  it('resolves to the registrant ALONE — never another participant', async () => {
    const scope = await adaLink()
    expect(scope.registrantName).toBe('Ada Lovelace')
    expect(JSON.stringify(scope)).not.toContain('Grace')
    expect(JSON.stringify(scope)).not.toContain('grace@example.test')
  })

  it('looks a teammate up by EXACT address and returns one name', async () => {
    const scope = await adaLink()
    const found = await lookupTeammate(scope, 'grace@example.test')
    expect(found).toMatchObject({ found: true, fullName: 'Grace Hopper' })
    expect(await lookupTeammate(scope, 'grace@')).toMatchObject({ found: false })
    expect(await lookupTeammate(scope, 'GRACE@EXAMPLE.TEST')).toMatchObject({ found: true })
  })

  it('refuses the registrant as their own teammate, and anyone already on a team', async () => {
    await openChallenge()
    const scope = await adaLink()
    expect(await lookupTeammate(scope, 'ada@example.test')).toMatchObject({ found: false })

    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    await inScope(() => confirmRegistration({
      scope, displayName: 'Alpha',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))
    // Katherine now registers and tries to take Grace.
    const kScope = await (async () => {
      await inScope(() => startRegistration({ email: 'katherine@example.test' }))
      return verifyLink(linkFrom(sent[sent.length - 1]!))
    })()
    expect(await lookupTeammate(kScope, 'grace@example.test'))
      .toMatchObject({ found: false, message: expect.stringMatching(/already on Alpha/) })
  })

  it("checks the name live against the owning module's normalisation", async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))

    expect(await checkTeamName('the night-shift!')).toMatchObject({ ok: false })
    expect((await checkTeamName('the night-shift!')).message).toMatch(/"Night Shift" already exists/)
    expect(await checkTeamName('Day Shift')).toMatchObject({ ok: true })
  })
})

describe('confirming (E44-S03)', () => {
  it('creates the team, its members, the contact and the token as ONE act', async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')

    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))

    expect(outcome).toMatchObject({ displayName: 'Night Shift', memberCount: 3, tokenEmailed: true })
    const team = await query<{ origin: string; contact_email: string }>(
      `SELECT origin, contact_email FROM team WHERE team_id = $1`, [outcome.teamId])
    expect(team.rows[0]).toEqual({ origin: 'REGISTRATION', contact_email: 'ada@example.test' })
    const members = await query<{ is_contact: boolean }>(
      `SELECT is_contact FROM team_member WHERE team_id = $1 ORDER BY is_contact DESC`, [outcome.teamId])
    expect(members.rows).toHaveLength(3)
    expect(members.rows.filter((m) => m.is_contact)).toHaveLength(1)
    const tokens = await query(`SELECT 1 FROM access_token WHERE team_id = $1`, [outcome.teamId])
    expect(tokens.rows).toHaveLength(1)
    const link = await query<{ used_at: Date | null; challenge_id: number | null }>(
      'SELECT used_at, challenge_id FROM registration_link')
    expect(link.rows[0]?.used_at).not.toBeNull()
    // Written as null: no challenge is chosen at registration any more.
    expect(link.rows[0]?.challenge_id).toBeNull()
  })

  it('emails the registration notice AFTER commit, to the registrant, with no code in it', async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))

    const notice = sent.find((m) => m.subject.includes('Night Shift is registered'))
    expect(notice?.to).toBe('ada@example.test')
    expect(outcome.emailedTo).toBe('ada@example.test')

    // The code goes out later as its own act (migration 103). Nothing here carries one — not
    // the email, not the DMs, not the response.
    for (const m of sent) expect(m.body).not.toMatch(/crs_/)
    expect(JSON.stringify(outcome)).not.toMatch(/crs_/)
  })

  it('refuses a team outside 3–8 BEFORE anything is created (E42-S02)', async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')

    await expect(inScope(() => confirmRegistration({
      scope, displayName: 'Pair', teammateIds: [grace.participantId!],
    }))).rejects.toThrow(/between 3 and 8 members; this one has 2/)
    expect((await query('SELECT 1 FROM team')).rows).toHaveLength(0)
  })

  it('does NOT ask for a challenge — that is chosen at submission', async () => {
    // Teams register in the half hour before coding starts, before most have settled on a path.
    // The answer that matters is taken on the submission form, where they know and where the
    // rubric they will be judged by is shown. The link's challenge column stays unwritten.
    await openChallenge('Open One')
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')

    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'No Challenge Yet',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))

    expect(outcome.teamId).toBeGreaterThan(0)
    const link = await query<{ challenge_id: number | null }>(
      'SELECT challenge_id FROM registration_link')
    expect(link.rows[0]?.challenge_id).toBeNull()
  })

  it('registers with no open challenge at all, because it does not need one', async () => {
    // Under the old rule this was impossible: the confirm re-checked the chosen id against the
    // open list and refused when the list was empty.
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')

    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Early Birds',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))
    expect(outcome.teamId).toBeGreaterThan(0)
  })

  it('is single-use under a race, and the loser leaves NO team behind', async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    const plan = {
      scope, displayName: 'Racers',
      teammateIds: [grace.participantId!, alan.participantId!],
    }

    const results = await Promise.allSettled([
      inScope(() => confirmRegistration(plan)),
      inScope(() => confirmRegistration({ ...plan, displayName: 'Racers Two' })),
    ])

    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    // The transaction is the point: the loser's team, members and token all rolled back.
    expect((await query('SELECT 1 FROM team')).rows).toHaveLength(1)
    expect((await query('SELECT 1 FROM access_token')).rows).toHaveLength(1)
  })

  it('refuses a used link, saying so (acceptance 5 and 7)', async () => {
    await openChallenge()
    await inScope(() => startRegistration({ email: 'ada@example.test' }))
    const raw = linkFrom(sent[0]!)
    const scope = await verifyLink(raw)
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    await inScope(() => confirmRegistration({
      scope, displayName: 'Done',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))

    await expect(verifyLink(raw)).rejects.toThrow(/already been used/)
  })

  it('records one audit event naming the participant id, never an address or token', async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    await inScope(() => confirmRegistration({
      scope, displayName: 'Audited',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))

    const audit = await query<{ actor: string; payload: unknown }>(
      `SELECT actor, payload FROM audit_event WHERE action = 'roster.team_registered'`)
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.actor).toBe(`participant:${scope.participantId}`)
    const dumped = JSON.stringify(audit.rows[0])
    expect(dumped).not.toContain('@example.test')
    expect(dumped).not.toMatch(/crs_/)
  })

  it('reports honestly when the token email fails — the team still exists', async () => {
    await openChallenge()
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    registerMailProvider(RECORDING_PROVIDER)

    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Unmailed',
      teammateIds: [grace.participantId!, alan.participantId!],
    }))
    expect(outcome.tokenEmailed).toBe(false)
    expect(outcome.message).toMatch(/could not be (sent|emailed)/)
    expect((await query('SELECT 1 FROM team')).rows).toHaveLength(1)
  })
})

describe('the delivery is recorded where organisers look (second review)', () => {
  const register = async (name: string) => {
    await openChallenge(name)
    const scope = await adaLink()
    const grace = await lookupTeammate(scope, 'grace@example.test')
    const alan = await lookupTeammate(scope, 'alan@example.test')
    return inScope(() => confirmRegistration({
      scope, displayName: name,
      teammateIds: [grace.participantId!, alan.participantId!],
    }))
  }

  it('records NOTHING at registration, because no code has been sent', async () => {
    // A delivery row here would tell the organiser's panel that every team holds a code while
    // none of them does, which is the exact gap the panel exists to surface (migration 103).
    const outcome = await register('Delivered')
    const row = await query<{ n: string }>(
      'SELECT count(*) AS n FROM token_delivery WHERE team_id = $1', [outcome.teamId])
    expect(Number(row.rows[0]!.n)).toBe(0)
  })

  it('records SENT with the provider reference once the code is handed out', async () => {
    const outcome = await register('Delivered')
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))

    const row = await query<{ status: string; provider_ref: string | null; template_version: number }>(
      `SELECT status, provider_ref, template_version FROM token_delivery
        WHERE team_id = $1 ORDER BY delivery_id LIMIT 1`,
      [outcome.teamId])
    expect(row.rows[0]).toMatchObject({ status: 'SENT', provider_ref: 'x' })
    // The version in use, which rises as the wording is corrected.
    const active = await query<{ version: number }>(
      `SELECT version FROM mail_template WHERE mail_key = 'mail.token_issued' AND active`)
    expect(Number(row.rows[0]?.template_version)).toBe(Number(active.rows[0]?.version))
  })

  it('records PREPARED, not SENT, when the adapter composed but transmitted nothing', async () => {
    // The recording adapter composes the message and hands it back for an organiser to send by
    // hand. PREPARED is that state, and it is deliberately not SENT: the whole point of this
    // table is that "we think they have it" and "it left the machine" are different claims.
    const outcome = await register('Undelivered')
    registerMailProvider(RECORDING_PROVIDER)
    await inScope(() => handOutCodes({ confirm: true, actor: ACTOR }))

    const row = await query<{ status: string }>(
      'SELECT status FROM token_delivery WHERE team_id = $1', [outcome.teamId])
    expect(row.rows[0]?.status).toBe('PREPARED')
    expect(row.rows[0]?.status).not.toBe('SENT')
  })
})
