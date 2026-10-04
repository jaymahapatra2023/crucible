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
  problems.push(...buildProblems(draft))
  return problems
}

/** Split out to keep `submissionProblems` inside its complexity budget. */
function buildProblems(draft: SubmissionDraft): string[] {
  const found: string[] = []
  const path = draft.dockerfilePath?.trim() ?? ''

  if (draft.buildMethod === 'DOCKERFILE') {
    if (path === '') {
      found.push('Give the path to your Dockerfile, relative to the repository root.')
    } else if (path.startsWith('/') || path.includes('..')) {
      // The prober refuses these outright and the entry is recorded as unbuildable. Far better
      // to say so here, while somebody is looking at the field, than after the deadline.
      found.push(
        'The Dockerfile path must be inside the repository — no leading slash and no "..". '
        + 'For example: Dockerfile, or backend/Dockerfile.')
    }
  }

  if (draft.buildMethod === 'COMMAND' && !draft.buildCommand?.trim()) {
    found.push('Give the command that builds and starts your application.')
  }
  return found
}


/**
 * Things that are probably wrong but might not be, so they are said and not enforced (E03-S01).
 *
 * Both of the first two entries at codeLinc 11 scored zero on the Runs dimension for a mistake
 * in this form rather than anything in their code. One pointed `npm install` at a directory with
 * no package.json; the other pasted its README instructions into the command box, so the probe
 * ran `sh -c "Frontend: cd apps/web && ..."` and got "Frontend:: not found". Both were a minute's
 * work to fix and neither team had any way of knowing.
 *
 * These are warnings, never blocks. The checks are guesses about intent, a guess that stops a
 * team submitting at four in the morning is worse than the mistake it prevents, and a team that
 * means exactly what they typed must be able to proceed.
 */
export function submissionWarnings(draft: SubmissionDraft): string[] {
  const warnings: string[] = []
  if (draft.buildMethod !== 'COMMAND') return warnings

  const command = draft.buildCommand?.trim() ?? ''
  if (command === '') return warnings

  // "Frontend:", "Backend:", "Start:" — a label, not a command. This is the exact shape that
  // cost an entry its Runs score, and `sh` reports it as "not found" on the first word.
  const first = command.split(/\s+/)[0] ?? ''
  const labels = command.match(/(?:^|\s)[A-Z][A-Za-z ]{0,20}:(?=\s)/g) ?? []
  if (first.endsWith(':') || labels.length >= 2 || /\n/.test(command)) {
    warnings.push(
      'This looks like instructions rather than one command. We run exactly what is in this box, '
      + 'as a single shell command — anything like "Frontend:" or "Start:" will be read as a '
      + 'program name and fail. Join the steps with && instead.')
  }

  // There was a second check here, for a bare `npm`/`pip` command, on the theory that the
  // manifest might be in a subdirectory. It fired on `npm ci && npm run build && npm start`,
  // which is correct and is what most teams type. A warning that shows for most entries teaches
  // people to dismiss the panel, which would cost us the one check that is precise. Where the
  // manifest lives cannot be known from this form, so it is stated as a hint on the field
  // instead — always visible, never crying wolf.

  return warnings
}
