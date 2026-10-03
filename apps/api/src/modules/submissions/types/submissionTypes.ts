/**
 * Submission intake types (E03).
 */
export const BUILD_METHODS = ['DOCKERFILE', 'COMMAND'] as const
export type BuildMethod = (typeof BUILD_METHODS)[number]

export const VALIDATION_STATUSES = [
  'PENDING', 'VALID', 'UNREACHABLE', 'PRIVATE', 'REJECTED',
] as const
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number]

/**
 * How an entry arrived (E17-S02 acceptance 4).
 *
 * `UNKNOWN` is carried only by rows written before team identity existed. Nothing writes it, and
 * it is kept rather than defaulted to one of the other two because guessing which of them an old
 * row was would put an invented fact in the audit trail.
 */
export const SUBMISSION_ROUTES = ['TEAM_TOKEN', 'ORGANISER', 'UNKNOWN'] as const
export type SubmissionRoute = (typeof SUBMISSION_ROUTES)[number]

export interface Submission {
  submissionId: number
  /** Identity. A rename changes the name, never this. */
  teamId: number
  /** The name as given AT THIS VERSION — a snapshot, not identity. */
  teamName: string
  contactEmail: string
  challengeId: number
  repoUrl: string
  buildMethod: BuildMethod
  dockerfilePath: string | null
  buildCommand: string | null
  artifactUrls: string[]
  version: number
  isCurrent: boolean
  supersededBy: number | null
  validationStatus: ValidationStatus
  validationDetail: string | null
  validatedAt: Date | null
  lockedCommitSha: string | null
  lockedAt: Date | null
  submittedAt: Date
  submittedBy: string | null
  submittedVia: SubmissionRoute
  /** The token that was presented, when one was. Answers "did they use their own?" */
  submittedTokenId: number | null
}

export interface ValidationEvent {
  eventId: number
  submissionId: number
  status: ValidationStatus
  detail: string | null
  commitSha: string | null
  durationMs: number | null
  checkedAt: Date
}

export interface SubmissionWindow {
  windowId: number
  name: string
  opensAt: Date
  closesAt: Date
  lockedAt: Date | null
  lockedBy: string | null
}

/** Per-challenge intake counts, read from the published view (E03-S05 acceptance 1). */
export interface IntakeHealth {
  challengeId: number
  total: number
  valid: number
  pending: number
  unreachable: number
  private: number
  rejected: number
  dockerfileBuilds: number
  commandBuilds: number
}
