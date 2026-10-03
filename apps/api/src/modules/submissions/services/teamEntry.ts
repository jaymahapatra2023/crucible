/**
 * What a team can see of their own entry (E17-S03).
 *
 * A team has no account, so until now the only way to find out whether their submission was
 * still valid was to email an organiser and wait. A repository that went private after
 * submission, or a commit that was force-pushed away, is a problem a team can fix themselves —
 * but only if they are told while there is still time.
 *
 * The token scopes the read. Everything returned is keyed on the team id the token carries, so
 * there is no parameter through which one team could ask about another's entry.
 */
import { query } from '../../../db/pool.js'
import { getTeam } from './teamService.js'
import { selectCurrentForTeam } from '../db/submissionDb.js'
import type { Submission, ValidationStatus } from '../types/submissionTypes.js'

export interface TeamEntry {
  submissionId: number
  challengeId: number
  challengeName: string
  version: number
  repoUrl: string
  validationStatus: ValidationStatus
  validationDetail: string | null
  validatedAt: Date | null
  lockedCommitSha: string | null
  submittedAt: Date
  /** Whether this entry was made with the team's own token, or by an organiser for them. */
  submittedOnTheirBehalf: boolean
  /** What to do about it, when there is something to do. Null when the entry is fine. */
  remedy: string | null
}

export interface TeamView {
  team: { teamId: number; displayName: string; contactEmail: string }
  entries: TeamEntry[]
  /** Said plainly, because an empty list is otherwise indistinguishable from a failed lookup. */
  message: string
}

/**
 * What each validation outcome means, and what the team can do about it.
 *
 * Written for the team rather than for an operator: the reader has no access to logs, cannot
 * see the intake dashboard, and is being asked to take an action, so each line names one.
 */
export function remedyFor(status: ValidationStatus, detail: string | null): string | null {
  switch (status) {
    case 'VALID':
      return null
    case 'PENDING':
      return 'We have not managed to read your repository yet. Check back shortly — if this is '
        + 'still here in an hour, contact your organiser.'
    case 'PRIVATE':
      return 'We cannot read your repository: it is private, or the access we were given has '
        + 'been withdrawn. Make it public, or re-grant access, then submit again to re-check.'
    case 'UNREACHABLE':
      return 'We could not reach your repository at that URL. Check the address is exactly what '
        + 'you would paste into a browser, then submit again.'
    case 'REJECTED':
      return `Your entry was not accepted: ${detail ?? 'the repository could not be used.'} `
        + 'Fix it and submit again — a new submission replaces this one.'
  }
}

export async function teamView(teamId: number): Promise<TeamView> {
  const team = await getTeam(teamId)
  const submissions = await selectCurrentForTeam(teamId)
  const names = await challengeNames(submissions)

  const entries = submissions.map((s): TeamEntry => ({
    submissionId: s.submissionId,
    challengeId: s.challengeId,
    challengeName: names.get(s.challengeId) ?? `Challenge ${s.challengeId}`,
    version: s.version,
    repoUrl: s.repoUrl,
    validationStatus: s.validationStatus,
    validationDetail: s.validationDetail,
    validatedAt: s.validatedAt,
    lockedCommitSha: s.lockedCommitSha,
    submittedAt: s.submittedAt,
    submittedOnTheirBehalf: s.submittedVia === 'ORGANISER',
    remedy: remedyFor(s.validationStatus, s.validationDetail),
  }))

  return {
    team: {
      teamId: team.teamId, displayName: team.displayName, contactEmail: team.contactEmail,
    },
    entries,
    message: entries.length === 0
      ? 'You have no entry recorded yet. Submitting one below is what puts it here.'
      : entries.every((e) => e.remedy === null)
        ? 'Everything we need is readable. Nothing to do.'
        : 'One or more entries need your attention — see what to do beside each.',
  }
}

/** Challenge names through the published view (P1.3), never by joining the challenge table. */
async function challengeNames(submissions: Submission[]): Promise<Map<number, string>> {
  const ids = [...new Set(submissions.map((s) => s.challengeId))]
  if (ids.length === 0) return new Map()

  const res = await query<{ challenge_id: number; name: string }>(
    'SELECT challenge_id, name FROM v_challenges_challenge WHERE challenge_id = ANY($1)', [ids])
  return new Map(res.rows.map((r) => [Number(r.challenge_id), r.name]))
}
