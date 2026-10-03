/**
 * Teams as records rather than typed strings (E17-S01).
 *
 * The epic this implements deliberately does not build a roster or a registration flow. A team
 * still has no Crucible account and no password (P8.2). What changes is that identity is a
 * stable id rather than whatever was typed into the form that day, so:
 *
 *   * a team that corrects its name keeps its submission lineage, and
 *   * the audit trail can answer whether a team submitted with their own token.
 */
import { AppError } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { registerTeamPort } from '../../../lib/ports/teamPort.js'
import { issueSubmissionToken } from './submissionTokens.js'
import { upsertDelivery } from '../db/deliveryDb.js'
import { mail } from '../../../lib/ports/mailPort.js'
import type { DbClient } from '../../../db/pool.js'
import {
  insertTeam, listTeams, selectSimilarTeams, selectTeam, updateTeam,
  type Team, type TeamOrigin,
} from '../db/teamDb.js'

export type { Team, TeamListing, TeamOrigin } from '../db/teamDb.js'

export async function getTeam(teamId: number, client?: DbClient): Promise<Team> {
  const team = await selectTeam(teamId, client)
  if (!team) throw new AppError('NOT_FOUND', `Team ${teamId} was not found.`)
  return team
}

export async function createTeam(input: {
  displayName: string
  contactEmail: string
  origin: TeamOrigin
  actor: string
  /** Join a caller's transaction (E44): a registration creates team, members and token as one act. */
  client?: DbClient
  contactDiscordUserId?: string | null
  /** Provisions this row as a claimable slot rather than a registered team (migration 095). */
  slotLabel?: string | null
}): Promise<Team> {
  const displayName = input.displayName.trim()
  const team = await insertTeam({
    displayName,
    contactEmail: input.contactEmail.trim(),
    origin: input.origin,
    createdBy: input.actor,
    ...(input.slotLabel !== undefined && { slotLabel: input.slotLabel }),
    contactDiscordUserId: input.contactDiscordUserId ?? null,
  }, input.client)
  await recordAudit({
    actor: input.actor, action: 'submissions.team_created', subjectType: 'team',
    subjectId: String(team.teamId),
    payload: { displayName, origin: input.origin },
  })
  return team
}

/**
 * Rename a team, or correct its contact.
 *
 * Recorded in the audit trail with both names, because "which team is this?" asked six months
 * later has to be answerable from the record and not from memory. The submissions themselves
 * keep the name as it was given at each version — that snapshot is what a team actually
 * submitted under, and rewriting it would falsify the entry.
 */
export async function reviseTeam(input: {
  teamId: number
  displayName?: string
  contactEmail?: string
  /** Absent: leave it. Null: the new contact has no Discord (E49). Never logged. */
  contactDiscordUserId?: string | null
  actor: string
}, client?: DbClient): Promise<Team> {
  const before = await getTeam(input.teamId, client)
  const change = teamChanges(before, input)
  if (Object.keys(change).length === 0) return before

  const renames = change.displayName !== undefined
  const recontacts = change.contactEmail !== undefined
  if (renames && change.displayName!.length < 2) {
    throw new AppError('VALIDATION_FAILED', 'A team name must be at least two characters.')
  }
  if (renames) await assertNoCollision(input.teamId, change.displayName!)

  const after = await updateTeam({ teamId: input.teamId, ...change }, client)
  if (!after) throw new AppError('NOT_FOUND', `Team ${input.teamId} was not found.`)

  if (renames) {
    await recordAudit({
      actor: input.actor, action: 'submissions.team_renamed', subjectType: 'team',
      subjectId: String(input.teamId),
      payload: { from: before.displayName, to: after.displayName },
    })
  }
  if (recontacts) {
    await recordAudit({
      actor: input.actor, action: 'submissions.team_contact_changed', subjectType: 'team',
      subjectId: String(input.teamId), payload: { to: after.contactEmail },
    })
  }
  return after
}

/** Only what actually differs, so a contact correction is not also a no-op rename in the audit. */
function teamChanges(before: Team, input: {
  displayName?: string; contactEmail?: string; contactDiscordUserId?: string | null
}): { displayName?: string; contactEmail?: string; contactDiscordUserId?: string | null } {
  const displayName = input.displayName?.trim()
  const contactEmail = input.contactEmail?.trim()
  return {
    ...(displayName !== undefined && displayName !== before.displayName && { displayName }),
    ...(contactEmail !== undefined && contactEmail !== before.contactEmail && { contactEmail }),
    ...(input.contactDiscordUserId !== undefined
      && input.contactDiscordUserId !== before.contactDiscordUserId
      && { contactDiscordUserId: input.contactDiscordUserId }),
  }
}

/**
 * The same comparison the stored column is generated from (E48-S01 acceptance 3): a rename that
 * collides in all but punctuation would make two teams nobody can tell apart on a ranking.
 * Named, so the organiser knows which team they are colliding with.
 */
async function assertNoCollision(teamId: number, displayName: string): Promise<void> {
  const clash = (await selectSimilarTeams(displayName)).find((t) => t.teamId !== teamId)
  if (clash) {
    throw new AppError('VALIDATION_FAILED',
      `"${displayName}" collides with the existing team "${clash.displayName}" (#${clash.teamId}) `
      + '— names are compared ignoring case and punctuation. Choose a name that is clearly '
      + 'different.')
  }
}

export const getTeams = listTeams
export const similarTeams = selectSimilarTeams

/**
 * The team port's implementation (ADR 0002).
 *
 * Registered at boot so the roster can read and create teams without importing this module. The
 * name lookup uses `selectSimilarTeams`, which compares through `team_normalise` — the same
 * function the stored column is generated from — so "the same name" means one thing whether the
 * caller is a spreadsheet import or an organiser typing.
 */
export function installTeamPort(): void {
  registerTeamPort({
    async list() {
      return (await listTeams()).map((t) => ({
        teamId: t.teamId, displayName: t.displayName, contactEmail: t.contactEmail,
        origin: t.origin,
      }))
    },

    async findByName(displayName) {
      const [found] = await selectSimilarTeams(displayName)
      return found === undefined
        ? null
        : {
          teamId: found.teamId, displayName: found.displayName,
          contactEmail: found.contactEmail, origin: found.origin,
        }
    },

    async create(input) {
      const team = await createTeam({
        displayName: input.displayName, contactEmail: input.contactEmail,
        // A team the participants formed themselves is recorded as such (P5.1): how a record
        // came to exist is a fact a reader deciding how much to trust it needs.
        origin: input.client ? 'REGISTRATION' : 'ORGANISER', actor: input.actor,
        ...(input.client && { client: input.client }),
        contactDiscordUserId: input.discordUserId ?? null,
      })
      return {
        teamId: team.teamId, displayName: team.displayName, contactEmail: team.contactEmail,
        origin: team.origin,
      }
    },

    async issueToken(input) {
      const issued = await issueSubmissionToken({
        label: input.label, teamId: input.teamId, issuedBy: input.actor,
        ...(input.client && { client: input.client }),
      })
      return { tokenId: issued.tokenId, token: issued.token }
    },

    async recordTokenDelivery(input) {
      await upsertDelivery({
        teamId: input.teamId, tokenId: input.tokenId, status: input.status,
        provider: mail().name, lastError: input.detail, providerRef: input.providerRef,
        templateVersion: input.templateVersion, channel: input.channel ?? 'email',
        preparedBy: input.actor,
      })
    },

    async setContactEmail(input) {
      await reviseTeam({
        teamId: input.teamId, contactEmail: input.contactEmail, actor: input.actor,
        ...(input.discordUserId !== undefined && { contactDiscordUserId: input.discordUserId }),
      })
    },
  })
}
