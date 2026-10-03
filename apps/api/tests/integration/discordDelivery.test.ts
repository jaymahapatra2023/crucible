/**
 * Discord AND email (E49, migration 100).
 *
 * `fetch` stands in for Discord. What is under test is the policy around it: that a recipient
 * with a Discord identity is reached on both channels and the record says so, that a partial
 * delivery is recorded as partial with the reason, that every member's username is resolved on
 * the SERVER at confirmation rather than trusted from the body, and that no Discord id reaches
 * a log line or an audit payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { resetEnvCache } from '../../src/config/env.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { registerMailProvider, resetMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { withBothChannels } from '../../src/modules/submissions/services/discordDelivery.js'
import { resetDiscordBreaker, setDiscordSleeper } from '../../src/lib/discord/discordClient.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import {
  checkDiscordUsername, confirmRegistration, startRegistration, verifyLink,
} from '../../src/modules/roster/services/registrationService.js'
import { reviseParticipant } from '../../src/modules/roster/services/rosterService.js'
import { assign, setContact } from '../../src/modules/roster/services/membershipService.js'
import { listParticipants } from '../../src/modules/roster/db/rosterDb.js'
import { issueSubmissionToken } from '../../src/modules/submissions/services/submissionTokens.js'
import { prepareDelivery } from '../../src/modules/submissions/services/tokenDelivery.js'
import { teams } from '../../src/lib/ports/teamPort.js'
import { setLogLevel, setLogSink } from '../../src/lib/logger.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const ADA_ID = '111111111111111111'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'discord' }, fn)

const PEOPLE = 'full_name,email\nAda Lovelace,ada@example.test\nGrace Hopper,grace@example.test\n'
  + 'Alan Turing,alan@example.test\nKatherine Johnson,katherine@example.test\n'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let emailed: MailMessage[]
let discordCalls: string[]
/** The stub Discord: who is in the server, and whether DMs are open. */
let members: Array<{ user: { id: string; username: string; global_name: string | null }; nick: string | null }>
let dmsOpen = true

function stubDiscord(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    discordCalls.push(url)
    if (url.includes('/members/search')) {
      const q = decodeURIComponent(url.split('query=')[1]!.split('&')[0]!).toLowerCase()
      return json(members.filter((m) => m.user.username.toLowerCase().startsWith(q)))
    }
    if (url.endsWith('/users/@me/channels')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { recipient_id: string }
      if (!members.some((m) => m.user.id === body.recipient_id)) return json({ code: 50007, message: 'Cannot send messages to this user' }, 403)
      return dmsOpen ? json({ id: `dm-${body.recipient_id}` }) : json({ code: 50007, message: 'Cannot send messages to this user' }, 403)
    }
    if (url.includes('/messages')) return json({ id: 'msg-1' })
    return json({}, 404)
  }))
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-for-tests-1234567890')
  vi.stubEnv('DISCORD_GUILD_ID', '999999999999999999')
  resetEnvCache()
  resetDiscordBreaker()
  setDiscordSleeper(async () => {})
  emailed = []
  discordCalls = []
  members = [{ user: { id: ADA_ID, username: 'ada_dev', global_name: 'Ada' }, nick: null }]
  dmsOpen = true
  stubDiscord()
  registerMailProvider(withBothChannels({
    name: 'fake', sends: true,
    async send(m) { emailed.push(m); return { delivered: true, detail: 'emailed', providerRef: 'mail-1' } },
  }))
  await inScope(() => importRoster({ kind: 'participant', csv: PEOPLE, confirm: true, actor: ACTOR }))
})

afterEach(() => {
  resetMailProvider()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetEnvCache()
  setLogSink(null)
})

const deliverTo = async (discordUserId: string | null) => {
  const issued = await inScope(() => issueSubmissionToken({ label: 'Team Alpha', contactEmail: 'alpha@test.local', issuedBy: ACTOR }))
  const report = await inScope(() => prepareDelivery({
    deliverables: [{ teamId: issued.teamId, tokenId: issued.tokenId, teamName: 'Team Alpha',
      contactEmail: 'alpha@test.local', discordUserId, token: issued.token }],
    actor: ACTOR,
  }))
  const row = await query<{ status: string; channel: string; last_error: string | null }>(
    'SELECT status, channel, last_error FROM token_delivery WHERE token_id = $1', [issued.tokenId])
  return { report, row: row.rows[0]! }
}

describe('one port, both channels (E49-S01, migration 100)', () => {
  it('sends to BOTH channels for a contact who has a Discord id', async () => {
    // The point of migration 100: the code arrives twice, so losing one route loses nothing.
    const { report, row } = await deliverTo(ADA_ID)
    expect(report.outcomes[0]!.status).toBe('SENT')
    expect(row).toMatchObject({ status: 'SENT', channel: 'both', last_error: null })
    expect(emailed).toHaveLength(1)
    expect(discordCalls.some((u) => u.includes('/messages'))).toBe(true)
  })

  it('records DISCORD alone, and says email did not go, when the relay fails', async () => {
    registerMailProvider(withBothChannels({
      name: 'broken', sends: true,
      async send() { throw new Error('relay refused the message') },
    }))
    const { report, row } = await deliverTo(ADA_ID)
    // Delivered: it reached the team. By one route of two, which the record has to show.
    expect(report.outcomes[0]!.status).toBe('SENT')
    expect(row.channel).toBe('discord')
    expect(row.last_error).toMatch(/relay refused/)
  })

  it('fails the delivery only when NEITHER channel carried it', async () => {
    dmsOpen = false
    registerMailProvider(withBothChannels({
      name: 'broken', sends: true,
      async send() { throw new Error('relay refused the message') },
    }))
    const { report, row } = await deliverTo(ADA_ID)
    expect(report.outcomes[0]!.status).toBe('FAILED')
    expect(row.status).toBe('FAILED')
  })

  it('records EMAIL alone, and says why, when the DM is refused', async () => {
    dmsOpen = false
    const { report, row } = await deliverTo(ADA_ID)
    expect(report.outcomes[0]!.status).toBe('SENT')
    expect(row.channel).toBe('email')
    expect(row.last_error).toMatch(/does not accept DMs/)
    expect(emailed).toHaveLength(1)
  })

  it('goes straight to email for a contact with no Discord id', async () => {
    const { row } = await deliverTo(null)
    expect(row.channel).toBe('email')
    expect(discordCalls).toHaveLength(0)
  })

  it('goes straight to email when the flag is off, without asking Discord', async () => {
    await setFlag('feature.notify.discord', false, ACTOR)
    invalidateConfig()
    const { row } = await deliverTo(ADA_ID)
    expect(row.channel).toBe('email')
    expect(discordCalls).toHaveLength(0)
  })
})

describe('the Discord identity, collected at registration (E49-S02)', () => {
  async function adaLink() {
    const before = emailed.length
    const outcome = await inScope(() => startRegistration({ email: 'ada@example.test' }))
    expect(outcome.status).toBe('SENT')
    // The LINK goes by email always: the roster knows no Discord identity yet.
    expect(emailed).toHaveLength(before + 1)
    const link = /crr_[A-Za-z0-9_-]+/.exec(emailed[emailed.length - 1]!.body)![0]
    return verifyLink(link)
  }
  const teammates = async () => (await listParticipants()).filter((p) => p.email !== 'ada@example.test').slice(0, 2).map((p) => p.participantId)

  it('confirms one exact username and never lists anybody', async () => {
    const scope = await adaLink()
    expect(scope.discord.enabled).toBe(true)
    expect(await checkDiscordUsername(scope, '@Ada_Dev')).toMatchObject({ found: true, displayName: 'Ada' })
    // A prefix is not a person: 'ad' matches nobody exactly, by username or display name.
    expect(await checkDiscordUsername(scope, 'ad')).toMatchObject({ found: false })
  })

  it('resolves the username on the server at confirm, stores the id, and notifies on both channels', async () => {
    const scope = await adaLink()
    const emailsBefore = emailed.length
    const challengeId = await openChallenge()
    const teammateIds = await teammates()
    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift', challengeId, teammateIds, discordUsername: 'ada_dev',
    }))
    expect(outcome.tokenSentVia).toBe('both')
    expect(outcome.discordNote).toBeNull()
    expect(outcome.message).toMatch(/sent to you on Discord and emailed to/)
    // Both, now: the registrant is DMed AND emailed (migration 100). The earlier behaviour —
    // email suppressed because the DM worked — left a team with one copy of the one string
    // they cannot do the event without.
    expect(emailed.slice(emailsBefore).some((m) => m.to === 'ada@example.test')).toBe(true)

    const team = await query<{ contact_discord_user_id: string | null }>(
      'SELECT contact_discord_user_id FROM team WHERE team_id = $1', [outcome.teamId])
    expect(team.rows[0]!.contact_discord_user_id).toBe(ADA_ID)

    // NO token delivery is recorded here (migration 103): the code has not been sent. Recording
    // one would tell the organiser's panel that every team holds a code when none of them does.
    const delivery = await query<{ n: string }>('SELECT count(*) AS n FROM token_delivery')
    expect(Number(delivery.rows[0]!.n)).toBe(0)
    // And nothing that went out carries one.
    for (const m of emailed) expect(m.body).not.toMatch(/crs_/)
  })

  it('carries on by email when the username is not in the server, and says to join it', async () => {
    const scope = await adaLink()
    const challengeId = await openChallenge()
    const teammateIds = await teammates()
    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift', challengeId, teammateIds, discordUsername: 'stranger',
    }))
    expect(outcome.tokenSentVia).toBe('email')
    expect(outcome.discordNote).toMatch(/Join the event server first/)
    const team = await query<{ contact_discord_user_id: string | null }>('SELECT contact_discord_user_id FROM team')
    expect(team.rows[0]!.contact_discord_user_id).toBeNull()
  })

  it('emails, and says why, when the DM is refused at confirm', async () => {
    dmsOpen = false
    const scope = await adaLink()
    const challengeId = await openChallenge()
    const teammateIds = await teammates()
    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift', challengeId, teammateIds, discordUsername: 'ada_dev',
    }))
    expect(outcome.tokenSentVia).toBe('email')
    expect(outcome.discordNote).toMatch(/does not accept DMs/)
  })

  it('puts no Discord id in any log line or audit payload (acceptance 5)', async () => {
    const lines: string[] = []
    setLogSink((line) => { lines.push(JSON.stringify(line)) })
    setLogLevel('debug')
    const scope = await adaLink()
    const challengeId = await openChallenge()
    const teammateIds = await teammates()
    await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift', challengeId, teammateIds, discordUsername: 'ada_dev',
    }))
    setLogLevel('error')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(ADA_ID)
    const audit = await query<{ payload: unknown }>('SELECT payload FROM audit_event')
    for (const row of audit.rows) expect(JSON.stringify(row.payload)).not.toContain(ADA_ID)
  })

  it('carries the contact\'s Discord id to the team when the point of contact is set', async () => {
    const [ada, grace] = await listParticipants()
    await inScope(() => reviseParticipant({ participantId: ada!.participantId, discordUsername: 'ada_dev', actor: ACTOR }))
    const team = await teams().create({ displayName: 'Held', contactEmail: 'x@test.local', actor: ACTOR })
    await inScope(() => assign({ teamId: team.teamId, participantId: grace!.participantId, actor: ACTOR }))
    await inScope(() => assign({ teamId: team.teamId, participantId: ada!.participantId, actor: ACTOR }))

    await inScope(() => setContact({ teamId: team.teamId, participantId: ada!.participantId, actor: ACTOR }))
    let row = await query<{ contact_discord_user_id: string | null }>('SELECT contact_discord_user_id FROM team WHERE team_id = $1', [team.teamId])
    expect(row.rows[0]!.contact_discord_user_id).toBe(ADA_ID)

    // A new contact with no Discord clears it: the team must not keep DMing the old one.
    await inScope(() => setContact({ teamId: team.teamId, participantId: grace!.participantId, actor: ACTOR }))
    row = await query('SELECT contact_discord_user_id FROM team WHERE team_id = $1', [team.teamId])
    expect(row.rows[0]!.contact_discord_user_id).toBeNull()
  })

  it('imports a discord column as given and resolves it through the People tab', async () => {
    await inScope(() => importRoster({
      kind: 'participant', csv: 'full_name,email,discord\nLinus T,linus@example.test,linus_t\n',
      confirm: true, actor: ACTOR,
    }))
    const linus = (await listParticipants()).find((p) => p.email === 'linus@example.test')!
    expect(linus).toMatchObject({ discordUsername: 'linus_t', discordUserId: null })
    members.push({ user: { id: '222222222222222222', username: 'linus_t', global_name: null }, nick: 'Linus' })
    const after = await inScope(() => reviseParticipant({ participantId: linus.participantId, discordUsername: 'linus_t', actor: ACTOR }))
    expect(after.discordUserId).toBe('222222222222222222')
  })
})

describe('every member, not just the registrant (migration 100)', () => {
  const GRACE_ID = '333333333333333333'

  async function adaLinkScope() {
    await inScope(() => startRegistration({ email: 'ada@example.test' }))
    const link = /crr_[A-Za-z0-9_-]+/.exec(emailed[emailed.length - 1]!.body)![0]
    return verifyLink(link)
  }

  it('resolves a TEAMMATE\'s username, stores it on their own row, and DMs them the code', async () => {
    members.push({ user: { id: GRACE_ID, username: 'grace_h', global_name: 'Grace' }, nick: null })
    const scope = await adaLinkScope()
    const people = await listParticipants()
    const grace = people.find((pp) => pp.email === 'grace@example.test')!
    const alan = people.find((pp) => pp.email === 'alan@example.test')!
    const before = emailed.length

    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift',
      teammateIds: [grace.participantId, alan.participantId],
      discordUsername: 'ada_dev',
      teammateDiscord: [{ participantId: grace.participantId, username: 'grace_h' }],
    }))

    expect(outcome.memberDiscordNotes).toEqual([])
    // Stored on the PARTICIPANT, not the team: it is a fact about Grace, and reminders read it.
    const stored = (await listParticipants()).find((pp) => pp.email === 'grace@example.test')!
    expect(stored).toMatchObject({ discordUsername: 'grace_h', discordUserId: GRACE_ID })
    const sent = emailed.slice(before)
    // ONE email to the team, with both teammates copied on it: Alan holds the code even though
    // he gave no Discord username.
    const team = sent.find((m) => m.to === 'ada@example.test')
    expect([...(team?.copyTo ?? [])].sort())
      .toEqual(['alan@example.test', 'grace@example.test'])
    // Grace ALSO gets a DM, because a DM has one recipient and a copy list cannot carry it.
    expect(sent.find((m) => m.to === 'grace@example.test')?.discordUserId).toBe(GRACE_ID)
    // Alan gets no second message at all — he is on the team email and has no Discord identity.
    expect(sent.filter((m) => m.to === 'alan@example.test')).toHaveLength(0)
    expect(discordCalls.filter((u) => u.endsWith('/users/@me/channels')).length).toBeGreaterThan(1)
  })

  it('IGNORES a participant id that is not on this team', async () => {
    // The confirm route is public and unauthenticated. A body naming somebody else's id would
    // otherwise rewrite a stranger's contact details from the registration page.
    members.push({ user: { id: GRACE_ID, username: 'grace_h', global_name: 'Grace' }, nick: null })
    const scope = await adaLinkScope()
    const people = await listParticipants()
    const grace = people.find((pp) => pp.email === 'grace@example.test')!
    const alan = people.find((pp) => pp.email === 'alan@example.test')!
    const outsider = people.find((pp) => pp.email === 'katherine@example.test')!

    await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift',
      teammateIds: [grace.participantId, alan.participantId],
      teammateDiscord: [{ participantId: outsider.participantId, username: 'grace_h' }],
    }))

    const after = (await listParticipants()).find((pp) => pp.participantId === outsider.participantId)!
    expect(after.discordUsername).toBeNull()
    expect(after.discordUserId).toBeNull()
  })

  it('names the teammate whose username could not be matched, and registers anyway', async () => {
    const scope = await adaLinkScope()
    const people = await listParticipants()
    const grace = people.find((pp) => pp.email === 'grace@example.test')!
    const alan = people.find((pp) => pp.email === 'alan@example.test')!

    const outcome = await inScope(() => confirmRegistration({
      scope, displayName: 'Night Shift',
      teammateIds: [grace.participantId, alan.participantId],
      teammateDiscord: [{ participantId: grace.participantId, username: 'not_in_server' }],
    }))

    expect(outcome.teamId).toBeGreaterThan(0)
    expect(outcome.memberDiscordNotes).toHaveLength(1)
    expect(outcome.memberDiscordNotes[0]).toContain('Grace Hopper')
    expect(outcome.memberDiscordNotes[0]).toContain('not_in_server')
    // Kept as typed so an organiser can see what they meant and fix it.
    const stored = (await listParticipants()).find((pp) => pp.email === 'grace@example.test')!
    expect(stored).toMatchObject({ discordUsername: 'not_in_server', discordUserId: null })
  })
})

async function openChallenge(): Promise<number> {
  const row = await query<{ challenge_id: number }>(
    `INSERT INTO challenge (name, slug, status, created_by)
     VALUES ('Reg Challenge', 'reg-challenge', 'OPEN', 'fixture')
     ON CONFLICT (slug) DO UPDATE SET status = 'OPEN' RETURNING challenge_id`)
  return Number(row.rows[0]!.challenge_id)
}
