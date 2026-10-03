/**
 * Intake dashboard reporting (E03-S05).
 *
 * The dashboard exists so problems are chased *before* the deadline. That makes two things
 * matter: the counts must be real backend counts (P5.7), and a failing submission must carry
 * the reason and the contact — an organiser cannot chase "3 invalid".
 */
import { csvDocument } from '../../../lib/csv.js'
import { logistics } from '../../../lib/ports/logisticsPort.js'
import { listSubmissions, selectIntakeHealth } from '../db/submissionDb.js'
import type { Submission } from '../types/submissionTypes.js'

export interface FailingSubmission {
  submissionId: number
  teamName: string
  contactEmail: string
  challengeId: number
  repoUrl: string
  validationStatus: string
  /** Why it failed, in the words a team can act on. */
  reason: string
  submittedAt: Date
  /**
   * Where to find them (E27-S03 acceptance 4).
   *
   * Null where the roster has not placed them, never a placeholder: an organiser walking to a
   * room needs to know the difference between "Ada Room" and "nobody has said".
   */
  roomLabel: string | null
  coachName: string | null
}

/** Everything not currently VALID, with the reason and who to contact (acceptance 2). */
export async function failingSubmissions(): Promise<FailingSubmission[]> {
  const all = await listSubmissions({ currentOnly: true }, 500, 0)
  const failing = all.filter((s) => s.validationStatus !== 'VALID')

  // One read for the whole list rather than one per row, and through the port because these
  // tables belong to the roster (ADR 0002).
  const place = await logistics().forTeams(failing.map((s) => s.teamId))

  return failing
    .map((s) => ({
      submissionId: s.submissionId,
      teamName: s.teamName,
      contactEmail: s.contactEmail,
      challengeId: s.challengeId,
      repoUrl: s.repoUrl,
      validationStatus: s.validationStatus,
      reason: s.validationDetail ?? 'Not yet validated.',
      submittedAt: s.submittedAt,
      roomLabel: place.get(s.teamId)?.roomLabel ?? null,
      coachName: place.get(s.teamId)?.coachName ?? null,
    }))
}

export interface IntakeDashboard {
  byChallenge: Awaited<ReturnType<typeof selectIntakeHealth>>
  totals: {
    total: number
    valid: number
    pending: number
    unreachable: number
    private: number
    rejected: number
  }
  failing: FailingSubmission[]
}

export async function intakeDashboard(): Promise<IntakeDashboard> {
  const byChallenge = await selectIntakeHealth()
  const totals = byChallenge.reduce(
    (acc, row) => ({
      total: acc.total + row.total,
      valid: acc.valid + row.valid,
      pending: acc.pending + row.pending,
      unreachable: acc.unreachable + row.unreachable,
      private: acc.private + row.private,
      rejected: acc.rejected + row.rejected,
    }),
    { total: 0, valid: 0, pending: 0, unreachable: 0, private: 0, rejected: 0 },
  )
  return { byChallenge, totals, failing: await failingSubmissions() }
}

export function toCsv(rows: readonly Submission[]): string {
  return csvDocument(
    [
      'submission_id', 'team_name', 'contact_email', 'challenge_id', 'repo_url',
      'build_method', 'dockerfile_path', 'build_command', 'version',
      'validation_status', 'validation_detail', 'locked_commit_sha', 'submitted_at',
    ],
    rows.map((s) => [
      s.submissionId, s.teamName, s.contactEmail, s.challengeId, s.repoUrl,
      s.buildMethod, s.dockerfilePath, s.buildCommand, s.version,
      s.validationStatus, s.validationDetail, s.lockedCommitSha,
      s.submittedAt.toISOString(),
    ]),
  )
}

export async function exportCsv(challengeId?: number): Promise<string> {
  const rows = await listSubmissions(
    { currentOnly: true, ...(challengeId !== undefined && { challengeId }) }, 1000, 0)
  return toCsv(rows)
}
