/**
 * Participants register their own teams (E44).
 *
 * The public surface of the roster, and the only one. Three things shape it:
 *
 *  - **Proof of an address already on the roster** is the whole authentication (II.2). A random,
 *    hashed, single-use, expiring link is sent to that address; holding the link is holding the
 *    right to form a team with that participant in it. No account, no password (P8.2).
 *  - **Nothing here lists anybody** (II.1). A teammate is looked up by exact address and the
 *    answer is one name or "not on the roster". A `<select>` of participants would be a public
 *    directory of 200 people's names and emails.
 *  - **Nothing is written until confirm**, and then everything is written in one transaction —
 *    team, memberships, contact, token — or nothing is (P7.1). The token is emailed AFTER commit:
 *    a token emailed inside a transaction that then rolls back is a credential for a team that
 *    does not exist.
 *
 * The team and its token belong to the submissions module and are reached through `teamPort`
 * with the transaction client passed through (ADR 0002).
 */
import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { mail } from '../../../lib/ports/mailPort.js'
import { teams } from '../../../lib/ports/teamPort.js'
import { tx } from '../../../db/pool.js'
import { getNumber, getString, isEnabled } from '../../platform/services/configService.js'
import {
  clearContact, insertMember, selectMembership, selectParticipant, selectParticipantByEmail,
  setContactFlag,
} from '../db/rosterDb.js'
import { claimNextSlot } from '../db/slotDb.js'
import {
  notifyAfterRegistration, registrationFacts, sendRegisteredAfterCommit,
} from './registrationNotices.js'
import { applyMemberDiscord, type MemberDiscordInput } from './memberDiscord.js'
import {
  consumeLink, insertLink, selectLinkByHash, supersedeLiveLinks,
  type RegistrationLink,
} from '../db/registrationDb.js'
import { assertTeamSize, teamSizeBounds } from './teamSizeRule.js'
import { resolveDiscordUsername } from './discordIdentity.js'
import { discordConfigured } from '../../../lib/discord/discordClient.js'
import { renderMail } from '../../submissions/services/mailTemplates.js'

const log = createLogger('roster', 'registration')

/** Distinct from `crs_`, so a registration link can never be mistaken for a submission token. */
const PREFIX = 'crr_'
const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

// ── S01: prove the address ────────────────────────────────────────────────────────────────

export interface StartOutcome {
  /** What the screen says. Never carries the link — that goes to the address, not the browser. */
  status: 'SENT' | 'NOT_ON_ROSTER' | 'ALREADY_ON_TEAM' | 'MAIL_FAILED'
  message: string
  /** Named when ALREADY_ON_TEAM, so the person knows which team rather than that one exists. */
  teamName?: string
}

export async function startRegistration(input: { email: string }): Promise<StartOutcome> {
  const participant = await selectParticipantByEmail(input.email)
  if (!participant) {
    // Said plainly (II.3): a form that could not say this is unusable for the honest case.
    return {
      status: 'NOT_ON_ROSTER',
      message: 'That address is not on the participant list. Check the spelling, or ask an '
        + 'organiser to add you.',
    }
  }

  const held = await selectMembership(participant.participantId)
  if (held) {
    const team = (await teams().list()).find((t) => t.teamId === held.teamId)
    const teamName = team?.displayName ?? 'a team'
    return {
      status: 'ALREADY_ON_TEAM', teamName,
      message: `You are already on ${teamName}. One team per person — ask an organiser if that `
        + 'is wrong.',
    }
  }

  const ttlMinutes = await getNumber('registration.link_ttl_minutes')
  const token = `${PREFIX}${randomBytes(24).toString('base64url')}`
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000)

  await tx(async (client) => {
    await supersedeLiveLinks(participant.participantId, client)
    await insertLink({ participantId: participant.participantId, tokenHash: hash(token), expiresAt }, client)
  })

  const bounds = await teamSizeBounds()
  const base = (await getString('event.register_url')).trim()
  const link = base === '' ? `the registration page (link: ${token})` : `${base}?link=${token}`
  const rendered = await renderMail('mail.registration_link', {
    participant_name: participant.fullName, link,
    min_size: bounds.min, max_size: bounds.max, ttl_minutes: ttlMinutes,
  })

  try {
    await mail().send({
      to: participant.email, subject: rendered.subject, body: rendered.body,
      // One key per link: a retried send of the same link is the same message.
      idempotencyKey: `registration-link/${hash(token).slice(0, 32)}`,
    })
  } catch (err) {
    log.error('registration link could not be sent', { participantId: participant.participantId, err })
    return {
      status: 'MAIL_FAILED',
      message: 'Your address is on the list, but the link could not be emailed just now. Try '
        + 'again in a minute, or ask an organiser.',
    }
  }

  // The id, never the address (P8.3).
  await recordAudit({
    actor: `participant:${participant.participantId}`, action: 'roster.registration_started',
    subjectType: 'participant', subjectId: String(participant.participantId),
    payload: { ttlMinutes },
  })
  log.info('registration link sent', { participantId: participant.participantId })

  return {
    status: 'SENT',
    message: `A link has been emailed to the address on the participant list. It works once and `
      + `expires in ${ttlMinutes} minutes.`,
  }
}

// ── S02: the link's scope ─────────────────────────────────────────────────────────────────

export interface LinkScope {
  linkId: number
  participantId: number
  /** The registrant's own name — the ONLY participant this ever returns (II.1). */
  registrantName: string
  registrantEmail: string
  /** Whether a Discord username can be checked and used for the code (E49). */
  discord: { enabled: boolean; inviteUrl: string }
  bounds: { min: number; max: number }
  expiresAt: Date
}

/** Verify a link at its mount point, the way a submission token is verified at its own. */
export async function verifyLink(presented: string): Promise<LinkScope> {
  if (!presented.startsWith(PREFIX)) {
    throw new AppError('UNAUTHENTICATED', 'That is not a registration link.')
  }
  const link = await selectLinkByHash(hash(presented))
  if (!link) throw new AppError('UNAUTHENTICATED', 'That registration link is not recognised.')
  refuseIfSpent(link)

  const participant = await selectParticipant(link.participantId)
  if (!participant) throw new AppError('UNAUTHENTICATED', 'That registration link is no longer valid.')

  return {
    linkId: link.linkId, participantId: participant.participantId,
    registrantName: participant.fullName, registrantEmail: participant.email,
    discord: {
      enabled: discordConfigured() && (await isEnabled('feature.notify.discord')),
      inviteUrl: (await getString('event.discord_invite_url')).trim(),
    },
    bounds: await teamSizeBounds(), expiresAt: link.expiresAt,
  }
}

function refuseIfSpent(link: RegistrationLink): void {
  if (link.usedAt !== null) {
    throw new AppError('PRECONDITION_FAILED',
      'That link has already been used to register a team. If you need to change the team, '
      + 'ask an organiser.')
  }
  if (link.supersededAt !== null) {
    throw new AppError('PRECONDITION_FAILED',
      'A newer registration link was sent to you; this one no longer works. Use the latest email.')
  }
  if (link.expiresAt.getTime() <= Date.now()) {
    throw new AppError('PRECONDITION_FAILED',
      'That link has expired. Start again from the registration page and a new one will be sent.')
  }
}

export interface LookupOutcome {
  found: boolean
  /** Only when found. Exactly one name, never a list. */
  participantId?: number
  fullName?: string
  message: string
}

/** A teammate by EXACT address. Confirms one match; never searches, never lists (II.1). */
export async function lookupTeammate(scope: LinkScope, email: string): Promise<LookupOutcome> {
  const person = await selectParticipantByEmail(email)
  if (!person) {
    return { found: false, message: 'No participant with that address. Check it with them.' }
  }
  if (person.participantId === scope.participantId) {
    return { found: false, message: "That is you — you're already on the team." }
  }
  const held = await selectMembership(person.participantId)
  if (held) {
    const team = (await teams().list()).find((t) => t.teamId === held.teamId)
    return {
      found: false,
      message: `${person.fullName} is already on ${team?.displayName ?? 'another team'}.`,
    }
  }
  return {
    found: true, participantId: person.participantId, fullName: person.fullName,
    message: `${person.fullName} — added.`,
  }
}

/** Live name check, by the owning module's normalisation (E44-S02 acceptance 5). */
export async function checkTeamName(displayName: string): Promise<{ ok: boolean; message: string }> {
  const trimmed = displayName.trim()
  if (trimmed.length < 2) return { ok: false, message: 'A team name needs at least two characters.' }
  const clash = await teams().findByName(trimmed)
  if (clash) {
    return {
      ok: false,
      message: `"${clash.displayName}" already exists, and names are compared ignoring case, `
        + 'punctuation and a leading "the". Choose one that differs by more than that.',
    }
  }
  return { ok: true, message: 'Available.' }
}

// ── S03: confirm — everything, or nothing ─────────────────────────────────────────────────

export interface ConfirmInput {
  scope: LinkScope
  displayName: string
  /** Teammates by id, as returned by lookups. The registrant is added regardless. */
  teammateIds: readonly number[]
  /**
   * The registrant's Discord username, re-resolved HERE against the event server (E49-S02): the
   * id a DM goes to is never taken from the request body, because a body that named somebody
   * else's id would send this team's code to a stranger.
   */
  discordUsername?: string | null
  /**
   * A Discord username per teammate who gave one (migration 100). Resolved here, same as the
   * registrant's, so the code reaches every member by DM as well as by email.
   */
  teammateDiscord?: readonly MemberDiscordInput[]
}

export interface ConfirmOutcome {
  teamId: number
  displayName: string
  memberCount: number
  /** Whether the token reached the team. Never the token itself (E44-S03 acceptance 4). */
  tokenEmailed: boolean
  emailedTo: string
  /** What carried the code (migration 100): both channels, one of them, or nothing yet. */
  tokenSentVia: 'discord' | 'email' | 'both' | null
  /** Why a channel that was tried did not carry it. */
  discordNote: string | null
  /** One sentence per teammate username that could not be used. Empty when all were fine. */
  memberDiscordNotes: string[]
  message: string
}

/**
 * Check a Discord username inside a registration (E49-S02 acceptance 1, 4). One name for one
 * exact username, or why not; never a list. The id stays on the server — confirm re-resolves.
 */
export async function checkDiscordUsername(scope: LinkScope, username: string): Promise<{
  found: boolean; displayName: string | null; message: string
}> {
  void scope
  const resolved = await resolveDiscordUsername(username)
  if (resolved.found) {
    return {
      found: true, displayName: resolved.note?.replace(/^Found in the event server as /, '').replace(/\.$/, '') ?? null,
      message: resolved.note ?? 'Found.',
    }
  }
  return { found: false, displayName: null, message: resolved.note ?? 'Enter a Discord username.' }
}

export async function confirmRegistration(input: ConfirmInput): Promise<ConfirmOutcome> {
  const { scope } = input
  const displayName = input.displayName.trim()

  // Re-checked here, not trusted from the screen: the UI is not a security boundary (E42-S02).
  const nameCheck = await checkTeamName(displayName)
  if (!nameCheck.ok) throw new AppError('CONFLICT', nameCheck.message)

  const memberIds = [...new Set([scope.participantId, ...input.teammateIds])]
  await assertTeamSize(memberIds.length)

  /*
   * No challenge is chosen here.
   *
   * Teams register in the half hour before coding begins, which is before most of them have
   * settled on a path. Asking then produced an answer that was a guess, and the answer that
   * matters is taken at submission, where the team knows and where the rubric it will be judged
   * by is shown to them. The link's challenge column stays, nullable and unwritten; nothing read
   * it even when it was filled in.
   */

  // Names kept while we have them: a note about an unmatched Discord username has to say WHICH
  // teammate it belongs to, and the registrant does not think of their team as id numbers.
  const names = new Map<number, string>()
  for (const id of memberIds) {
    const person = await selectParticipant(id)
    if (!person) throw new AppError('UNPROCESSABLE', `Participant ${id} is not on the roster.`)
    names.set(id, person.fullName)
    const held = await selectMembership(id)
    if (held) {
      const team = (await teams().list()).find((t) => t.teamId === held.teamId)
      throw new AppError('CONFLICT',
        `${person.fullName} is already on ${team?.displayName ?? 'another team'}.`)
    }
  }

  const actor = `participant:${scope.participantId}`

  // Everything, or nothing (P7.1). The plaintext leaves this block in memory only.
  // Resolved now, not trusted from the screen, for the same reason the name is re-checked.
  const discord = await resolveDiscordUsername(input.discordUsername)

  /*
   * Every member who gave a Discord username, resolved and stored on their own participant row
   * (migration 100) — the registrant's included, so reminders reach them later by both routes
   * too and nobody retypes it.
   *
   * Only members of THIS team: a body naming a participant id from another team would otherwise
   * rewrite a stranger's contact details from a public, unauthenticated page.
   */
  const given: MemberDiscordInput[] = [
    ...(discord.username === null
      ? []
      : [{ participantId: scope.participantId, username: discord.username }]),
    ...(input.teammateDiscord ?? []).filter((m) => names.has(m.participantId)
      && m.participantId !== scope.participantId),
  ]
  const memberDiscord = await applyMemberDiscord(given, names)

  const created = await tx(async (client) => {
    /*
     * Take a pre-provisioned slot if there is one (migration 095). The slot already has its room
     * and its coach, so claiming it is how a team gets placed without anybody matching teams to
     * rooms on the day.
     *
     * When the pool is exhausted the registration still succeeds and the team is simply unplaced.
     * The organisers may provision forty slots and sixty teams may turn up; refusing the
     * sixty-first registration would be the worst possible failure, and an unplaced team is a
     * line on the roster readiness panel rather than a student who cannot enter.
     */
    const claimed = await claimNextSlot({
      displayName, contactEmail: scope.registrantEmail, contactDiscordUserId: discord.userId,
    }, client)

    const team = claimed === null
      ? await teams().create({
        displayName, contactEmail: scope.registrantEmail, actor, client,
        discordUserId: discord.userId,
      })
      : { teamId: claimed.teamId, displayName, contactEmail: scope.registrantEmail }
    for (const id of memberIds) {
      await insertMember({ teamId: team.teamId, participantId: id, isContact: false, actor }, client)
    }
    await clearContact(team.teamId, client)
    await setContactFlag(team.teamId, scope.participantId, client)

    const token = await teams().issueToken({
      teamId: team.teamId, label: displayName, actor, client,
    })

    // Single-use under concurrency: only the confirm whose UPDATE lands proceeds.
    const consumed = await consumeLink(
      { linkId: scope.linkId, teamId: team.teamId, challengeId: null }, client)
    if (!consumed) {
      throw new AppError('PRECONDITION_FAILED',
        'That link was used a moment ago. Only one team can be registered from it.')
    }
    return { team, token, slotLabel: claimed?.slotLabel ?? null }
  })

  await recordAudit({
    actor, action: 'roster.team_registered', subjectType: 'team',
    subjectId: String(created.team.teamId),
    // The count and the ids — never an address, never the token (P8.3).
    payload: { memberCount: memberIds.length, memberIds },
  })

  // Everyone except the registrant, who is the To. Read from the roster rather than the form,
  // like every other address this flow uses.
  const copyTo = (await Promise.all(
    memberIds.filter((id) => id !== scope.participantId).map((id) => selectParticipant(id)),
  )).flatMap((p) => (p === null ? [] : [p.email]))

  /*
   * What the team is told now: where they sit, who their coach is, who is on the team.
   *
   * NOT the submission code (migration 103). A team registers in the half hour before coding
   * starts, when a code is of no use to them, and a code emailed at 9am sits in ninety-nine
   * inboxes all day with every hour another chance of it being forwarded or pasted into a
   * channel. It is sent later as its own deliberate act.
   *
   * Rendered once and reused for the email and every DM, so no member reads a different message.
   */
  const facts = await registrationFacts({
    teamId: created.team.teamId, displayName, memberIds,
  })

  const sent = await sendRegisteredAfterCommit({
    teamId: created.team.teamId, displayName, facts,
    to: scope.registrantEmail, copyTo, discordUserId: discord.userId, actor,
  })
  // After the registrant's copy: every other member's DM, and the coach (migration 097).
  const notices = await notifyAfterRegistration({
    teamId: created.team.teamId, displayName, registrationFacts: facts,
    memberIds, registrantParticipantId: scope.participantId, actor,
  })

  log.info('team registered', {
    teamId: created.team.teamId, members: memberIds.length, sentVia: sent.via,
    slot: created.slotLabel, coachTold: notices.coachNotified,
  })

  // Said when a channel that was meant to carry it did not — including when both were asked for
  // and only one went, which `fallbackReason` is exactly how the port reports (migration 100).
  const discordNote = sent.via === 'both' ? null
    : discord.username !== null || sent.fallbackReason !== null
      ? (sent.fallbackReason ?? discord.note)
      : null
  return {
    teamId: created.team.teamId, displayName, memberCount: memberIds.length,
    tokenEmailed: sent.via === 'email' || sent.via === 'both', emailedTo: scope.registrantEmail,
    tokenSentVia: sent.via, discordNote, memberDiscordNotes: memberDiscord.notes,
    message: outcomeMessage(sent.via, displayName, scope.registrantEmail),
  }
}

/** What the screen says about where the code went. Written out, never implied by a colour (P5.4). */
function outcomeMessage(
  via: 'discord' | 'email' | 'both' | null, displayName: string, email: string,
): string {
  if (via === 'both') {
    return `${displayName} is registered. Your submission code has been sent to you on Discord `
      + `and emailed to ${email}.`
  }
  if (via === 'discord') {
    return `${displayName} is registered. Your submission code has been sent to you on Discord.`
  }
  if (via === 'email') {
    return `${displayName} is registered. Your submission code has been emailed to ${email}.`
  }
  return `${displayName} is registered, but the submission code could not be sent just now. `
    + 'An organiser can see this and will send it another way.'
}
