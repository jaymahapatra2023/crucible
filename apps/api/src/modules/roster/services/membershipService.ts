/**
 * Assigning participants to teams (E28-S01).
 *
 * The rule the database enforces is that a participant is on **at most one team**. Everything
 * here is about making that rule's refusal useful: an operator moving somebody needs to know
 * which team already has them, not that an index was violated.
 *
 * Teams are reached through `teamPort`, never by importing the submissions module (ADR 0002).
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { teams, type TeamSummary } from '../../../lib/ports/teamPort.js'
import { tx } from '../../../db/pool.js'
import {
  clearContact, countParticipants, countUnassigned, deleteMember, insertMember,
  listMembers, listTeamSizes, listUnassigned, selectMembership, selectParticipant,
  setContactFlag, type TeamMember,
} from '../db/rosterDb.js'
import { getLogistics } from './rosterService.js'
import { assertCanRemoveMember } from './teamSizeRule.js'
import type { Participant } from '../types/rosterTypes.js'

const log = createLogger('roster', 'membership')

export interface TeamOnBoard {
  teamId: number
  displayName: string
  contactEmail: string
  members: TeamMember[]
  roomLabel: string | null
  coachName: string | null
}

export interface RosterBoard {
  unassigned: Participant[]
  /** The real total, beside a bounded list (P5.7). This is the number that says whether it is done. */
  unassignedTotal: number
  participantTotal: number
  teams: TeamOnBoard[]
}

/**
 * Everything the assignment surface needs, in one read.
 *
 * Assembled here rather than joined in SQL because teams belong to another module: three reads
 * composed at the service layer is what ADR 0002 asks for in place of a cross-module join.
 */
export async function rosterBoard(): Promise<RosterBoard> {
  const [unassigned, unassignedTotal, participantTotal, allTeams, members, sizes, logistics] =
    await Promise.all([
      listUnassigned(), countUnassigned(), countParticipants(),
      teams().list(), listMembers(), listTeamSizes(), getLogistics(),
    ])

  const byTeam = new Map<number, TeamMember[]>()
  for (const member of members) {
    byTeam.set(member.teamId, [...(byTeam.get(member.teamId) ?? []), member])
  }
  const place = new Map(logistics.map((l) => [l.teamId, l]))
  const contact = new Map(sizes.map((s) => [s.teamId, s.contactEmail]))

  return {
    unassigned,
    unassignedTotal,
    participantTotal,
    teams: allTeams.map((team) => ({
      teamId: team.teamId,
      displayName: team.displayName,
      // The point of contact's address where one is set, the team's own otherwise.
      contactEmail: contact.get(team.teamId) ?? team.contactEmail,
      members: byTeam.get(team.teamId) ?? [],
      roomLabel: place.get(team.teamId)?.roomLabel ?? null,
      coachName: place.get(team.teamId)?.coachName ?? null,
    })),
  }
}

/**
 * Create a team from the assignment surface (E28-S02 acceptance 7).
 *
 * A team that does not exist yet is the commonest reason an assignment cannot be made, so the
 * operator has to be able to make one without leaving the screen they are working on.
 *
 * Two things this deliberately does NOT do:
 *
 *  - **It does not invent a contact address.** A team must hold one (E17), and the honest source
 *    is the first member's, so naming a first member is the normal path. A team created with
 *    nobody on it has no contact yet, and `rosterReadiness` says so by name rather than the
 *    address being quietly empty.
 *  - **It does not silently reuse a team whose name only looks different.** "The Night Shift" and
 *    "Night Shift" compare equal by the owning module's normalisation; returning the existing one
 *    under a name the operator did not type would hide the collision rather than report it.
 *
 * Every refusal happens BEFORE the team is created, so a rejected attempt leaves no empty team
 * behind for somebody to puzzle over later.
 */
export async function createTeam(input: {
  displayName: string
  participantId?: number
  actor: string
}): Promise<{ team: TeamSummary; contact: TeamMember | null }> {
  const clash = await teams().findByName(input.displayName)
  if (clash) {
    throw new AppError('CONFLICT',
      `${clash.displayName} already exists, and team names are compared ignoring case, `
      + `punctuation and a leading "the" — so "${input.displayName}" would be the same team. `
      + `Assign to ${clash.displayName}, or choose a name that differs by more than that.`)
  }

  const participant = input.participantId === undefined
    ? null
    : await selectParticipant(input.participantId)
  if (input.participantId !== undefined && !participant) {
    throw new AppError('NOT_FOUND', `Participant ${input.participantId} was not found.`)
  }
  if (participant) {
    const held = await selectMembership(participant.participantId)
    if (held) {
      const holder = (await teams().list()).find((t) => t.teamId === held.teamId)
      throw new AppError('CONFLICT',
        `${participant.fullName} is already on ${holder?.displayName ?? `team ${held.teamId}`}, `
        + `so ${input.displayName} was not created. Take them off that team first.`)
    }
  }

  const team = await teams().create({
    displayName: input.displayName.trim(),
    contactEmail: participant?.email ?? '',
    actor: input.actor,
  })

  await recordAudit({
    actor: input.actor, action: 'roster.team_created', subjectType: 'team',
    subjectId: String(team.teamId),
    // The participant id, never their address (P8.3).
    payload: { withParticipantId: participant?.participantId ?? null },
  })
  log.info('team created', { teamId: team.teamId, seeded: participant !== null })

  const contact = participant
    ? await assign({
      teamId: team.teamId, participantId: participant.participantId,
      asContact: true, actor: input.actor,
    })
    : null

  return { team, contact }
}

/**
 * Put a participant on a team.
 *
 * The first member becomes the point of contact unless told otherwise, because a team whose
 * contact is nobody is a team that cannot be sent its token — and the commonest case is that the
 * first person added is the one who registered.
 */
export async function assign(input: {
  teamId: number
  participantId: number
  asContact?: boolean
  actor: string
}): Promise<TeamMember> {
  const participant = await selectParticipant(input.participantId)
  if (!participant) {
    throw new AppError('NOT_FOUND', `Participant ${input.participantId} was not found.`)
  }

  const existing = await selectMembership(input.participantId)
  if (existing) {
    if (existing.teamId === input.teamId) return existing
    // Names the team rather than reporting a constraint. An operator reassigning somebody needs
    // to know where they are now, which is the whole content of the refusal.
    const holder = (await teams().list()).find((t) => t.teamId === existing.teamId)
    throw new AppError('CONFLICT',
      `${participant.fullName} is already on ${holder?.displayName ?? `team ${existing.teamId}`}. `
      + `Take them off that team first, or move them directly.`)
  }

  const sizes = await listTeamSizes()
  const size = sizes.find((s) => s.teamId === input.teamId)
  const isContact = input.asContact ?? (size === undefined || size.members === 0)

  await tx(async (client) => {
    if (isContact) await clearContact(input.teamId, client)
    await insertMember({ ...input, isContact }, client)
  })

  if (isContact) await syncTeamContact(input.teamId, participant, input.actor)

  await recordAudit({
    actor: input.actor, action: 'roster.member_assigned', subjectType: 'team',
    subjectId: String(input.teamId),
    // The participant id, not their name or address (P8.3).
    payload: { participantId: input.participantId, asContact: isContact },
  })
  log.info('participant assigned', { teamId: input.teamId, participantId: input.participantId })

  const member = await selectMembership(input.participantId)
  if (!member) throw new AppError('INTERNAL_ERROR', 'The assignment did not take.')
  return member
}

/** Take a participant off their team. The participant is untouched; only the membership goes. */
export async function unassign(input: {
  participantId: number
  actor: string
}): Promise<void> {
  const existing = await selectMembership(input.participantId)
  if (!existing) {
    throw new AppError('NOT_FOUND',
      `Participant ${input.participantId} is not on a team.`)
  }

  // The size rule is the contract with entrants (E42-S02 acceptance 3): a team the participants
  // registered may not be reduced below it, by anybody. A team an organiser assembled is not
  // bound — a half-formed team on the day is theirs to fix (acceptance 4).
  const holder = (await teams().list()).find((t) => t.teamId === existing.teamId)
  if (holder?.origin === 'REGISTRATION') {
    const size = (await listTeamSizes()).find((t) => t.teamId === existing.teamId)?.members ?? 0
    await assertCanRemoveMember(size)
  }

  await deleteMember(input.participantId)

  await recordAudit({
    actor: input.actor, action: 'roster.member_unassigned', subjectType: 'team',
    subjectId: String(existing.teamId),
    payload: { participantId: input.participantId, wasContact: existing.isContact },
  })
  log.info('participant unassigned', {
    teamId: existing.teamId, participantId: input.participantId,
  })
}

/** Move a participant from whatever team they are on to this one, in one act. */
export async function move(input: {
  teamId: number
  participantId: number
  actor: string
}): Promise<TeamMember> {
  const existing = await selectMembership(input.participantId)
  if (existing && existing.teamId !== input.teamId) {
    await unassign({ participantId: input.participantId, actor: input.actor })
  }
  return assign(input)
}

/** Name the person the team is reached through. */
export async function setContact(input: {
  teamId: number
  participantId: number
  actor: string
}): Promise<TeamMember> {
  const member = await selectMembership(input.participantId)
  if (!member || member.teamId !== input.teamId) {
    throw new AppError('PRECONDITION_FAILED',
      'That participant is not on this team, so they cannot be its point of contact.')
  }

  await tx(async (client) => {
    await clearContact(input.teamId, client)
    await setContactFlag(input.teamId, input.participantId, client)
  })
  await syncTeamContact(input.teamId, member, input.actor)

  await recordAudit({
    actor: input.actor, action: 'roster.contact_set', subjectType: 'team',
    subjectId: String(input.teamId), payload: { participantId: input.participantId },
  })
  const updated = await selectMembership(input.participantId)
  return updated ?? member
}

/**
 * Carry the point of contact's address onto the team.
 *
 * E17 requires a team to hold a contact, and the roster now knows a better answer than whatever
 * was typed when the team was created. Through the port, because `team` is not this module's.
 */
/** The address and, since E49, the Discord id — null when the contact has none, so a team does
 *  not keep DMing a previous contact. */
async function syncTeamContact(
  teamId: number, contact: { email: string; discordUserId?: string | null }, actor: string,
): Promise<void> {
  await teams().setContactEmail({
    teamId, contactEmail: contact.email, actor, discordUserId: contact.discordUserId ?? null,
  })
}

export { listMembers, listUnassigned, listTeamSizes } from '../db/rosterDb.js'
