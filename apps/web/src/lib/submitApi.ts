/** The public submission surface a team uses (E03-S01). */
import { getAsTeam, getPublic, postAsTeam } from './apiClient.js'

export const BUILD_METHODS = ['DOCKERFILE', 'COMMAND'] as const
export type BuildMethod = (typeof BUILD_METHODS)[number]

/** Mirrors the server's `IntakeStatus` exactly — the window is nested, not flattened. */
export interface IntakeStatus {
  state: 'NO_WINDOW' | 'NOT_YET_OPEN' | 'OPEN' | 'CLOSED' | 'LOCKED'
  message: string
  window: { name: string; opensAt: string; closesAt: string; lockedAt: string | null } | null
}

export interface SubmissionDraft {
  contactEmail: string
  challengeId: number
  repoUrl: string
  buildMethod: BuildMethod
  dockerfilePath?: string
  buildCommand?: string
  artifactUrls: string[]
}

/** What the API returns. Mirrors the server's `Submission`, narrowed to what a team is shown. */
export interface SubmissionReceipt {
  submissionId: number
  teamName: string
  repoUrl: string
  validationStatus: string
  validationDetail: string | null
  lockedCommitSha: string | null
  version: number
}

export interface OpenChallenge {
  challengeId: number
  name: string
  /**
   * Addresses the published rubric, when one is published (E17-S04).
   *
   * Null means the standard is not readable yet. The form says so rather than linking nothing:
   * a team is entitled to read what they will be judged by before they enter.
   */
  rubricSlug: string | null
}

/** A team's own entry, read with their token (E17-S03). */
export interface TeamEntry {
  submissionId: number
  challengeId: number
  challengeName: string
  version: number
  repoUrl: string
  validationStatus: string
  validationDetail: string | null
  lockedCommitSha: string | null
  submittedAt: string
  submittedOnTheirBehalf: boolean
  /** What to do about it. Null when there is nothing to do. */
  remedy: string | null
}

export interface TeamView {
  team: { teamId: number; displayName: string; contactEmail: string }
  entries: TeamEntry[]
  message: string
}

export const getMyEntry = (token: string) => getAsTeam<TeamView>('/submissions/mine', token)

/**
 * What a token resolves to, for the form (E45-S01).
 *
 * The same read as "look up my entry": the token IS the team, so the page displays the team it
 * names rather than asking for a name it could get wrong. A token bound to no team fails here,
 * at the form, with the server's reason — not at submission.
 */
export const resolveToken = getMyEntry

/** Where a team reads the standard they will be judged by. Public by design (P8.1). */
export const rubricHref = (slug: string) => `/api/v1/rubrics/published/${slug}`

export const getIntakeWindow = () => getPublic<IntakeStatus>('/submissions/status')
export const getOpenChallenges = () => getPublic<OpenChallenge[]>('/challenges/open')

export const submitEntry = (draft: SubmissionDraft, token: string) =>
  postAsTeam<SubmissionReceipt>('/submissions', draft, token)

/**
 * Problems a team should see before they submit.
 *
 * Checked here as well as server-side so a team finds out while they can still fix it, rather
 * than after a round trip that returns a schema error naming no field.
 */
export function submissionProblems(draft: SubmissionDraft, token: string): string[] {
  const problems: string[] = []
  if (token.trim() === '') {
    problems.push('Paste the submission token your organiser sent with your team invitation.')
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.contactEmail.trim())) {
    problems.push('Enter a contact email we can reach you on if the repository will not clone.')
  }
  if (draft.challengeId <= 0) problems.push('Choose the challenge you are entering.')
  if (!/^https?:\/\/.+|^git@.+:.+/.test(draft.repoUrl.trim())) {
    problems.push('Enter the repository URL, starting with https:// or git@.')
  }
  if (draft.buildMethod === 'DOCKERFILE' && !draft.dockerfilePath?.trim()) {
    problems.push('Give the path to your Dockerfile, relative to the repository root.')
  }
  if (draft.buildMethod === 'COMMAND' && !draft.buildCommand?.trim()) {
    problems.push('Give the command that builds and starts your application.')
  }
  return problems
}
