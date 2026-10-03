/** Intake dashboard, submission tokens and the intake window (E03-S01, E03-S04, E03-S05). */
import { del, get, getPage, post, type Page } from './apiClient.js'
import type { PreflightSummary } from './teamAdminApi.js'

export interface ChallengeIntake {
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

export interface FailingSubmission {
  submissionId: number
  teamName: string
  contactEmail: string
  challengeId: number
  repoUrl: string
  validationStatus: string
  reason: string
  submittedAt: string
  /** Where to find them. Null where the roster has not placed them — never a placeholder. */
  roomLabel: string | null
  coachName: string | null
}

export interface IntakeDashboard {
  byChallenge: ChallengeIntake[]
  totals: {
    total: number; valid: number; pending: number
    unreachable: number; private: number; rejected: number
  }
  failing: FailingSubmission[]
}

export interface IntakeStatus {
  state: 'NO_WINDOW' | 'NOT_YET_OPEN' | 'OPEN' | 'CLOSED' | 'LOCKED'
  message: string
  window: { name: string; opensAt: string; closesAt: string; lockedAt: string | null } | null
}

export const VALIDATION_STATUSES = [
  'PENDING', 'VALID', 'UNREACHABLE', 'PRIVATE', 'REJECTED',
] as const
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number]

/** One entry as an organiser needs to see it (E39). */
export interface SubmissionRow {
  submissionId: number
  teamId: number
  teamName: string
  contactEmail: string
  challengeId: number
  repoUrl: string
  buildMethod: 'DOCKERFILE' | 'COMMAND'
  version: number
  validationStatus: ValidationStatus
  validationDetail: string | null
  lockedCommitSha: string | null
  submittedAt: string
  submittedVia: string
  /** What tier 2 last concluded (E46). Null when the entry was never queued. */
  preflight: PreflightSummary | null
}

export {
  reissueToken, revealToken, runPreflight, updateTeam,
  type NoticeStatus, type PreflightStatus, type PreflightSummary, type PreflightVerdict,
} from './teamAdminApi.js'

/**
 * Every entry, not only the failing ones.
 *
 * The dashboard itemises failures and counts everything else, which leaves "what did this team
 * submit, and is it valid?" unanswerable for a team whose entry is fine.
 */
export const SUBMISSION_SORTS = ['submitted', 'team', 'challenge', 'status', 'version'] as const
export type SubmissionSort = (typeof SUBMISSION_SORTS)[number]

export const listSubmissions = (filters: {
  challengeId?: number
  status?: ValidationStatus
  sort?: SubmissionSort
  page?: number
  pageSize?: number
}) => {
  const params = new URLSearchParams()
  if (filters.challengeId !== undefined) params.set('challengeId', String(filters.challengeId))
  if (filters.status !== undefined) params.set('status', filters.status)
  if (filters.sort !== undefined) params.set('sort', filters.sort)
  params.set('page', String(filters.page ?? 1))
  // MAX_PAGE_SIZE is 100 server-side; asking for more is a 400, not a larger page.
  params.set('pageSize', String(Math.min(filters.pageSize ?? 25, 100)))
  return getPage<SubmissionRow>(`/submissions?${params.toString()}`)
}

export type SubmissionPage = Page<SubmissionRow>

export const getIntakeDashboard = () => get<IntakeDashboard>('/submissions/dashboard')
export const getIntakeStatus = () => get<IntakeStatus>('/submissions/status')

// ── Tokens and the submission window (E03-S01, E03-S04, P8.2) ─────────────────────────────

export interface SubmissionToken {
  tokenId: number
  label: string
  issuedAt: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  /** Whether an admin could reveal it: sealed at issue and not revoked (ADR 0005). */
  revealable: boolean
  /**
   * The team this token IS (E17-S01).
   *
   * Null only for a token issued before teams had identity whose label matched more than one
   * team. Such a token is refused at submission time, so the panel shows it as unbound rather
   * than leaving a team to discover it at their deadline.
   */
  teamId: number | null
  teamName: string | null
}

/** A team as a record, not a string typed into a form (E17-S01). */
export interface Team {
  teamId: number
  displayName: string
  normalisedName: string
  contactEmail: string
  origin: 'TOKEN' | 'ORGANISER' | 'BACKFILL' | 'REGISTRATION'
  createdAt: string
}

/**
 * A team in the organiser's list, with what an organiser needs to act on.
 *
 * Separate from `Team` because the two endpoints genuinely return different shapes: the
 * similar-name advisory is the bare record. Declaring one type for both is how a client drifts
 * from its server, which has cost this project two regressions already.
 */
export interface TeamListing extends Team {
  activeTokens: number
  currentSubmissions: number
}

/** The issue response. `token` is the only moment the plaintext exists (P8.3). */
export interface IssuedToken {
  tokenId: number
  label: string
  token: string
  expiresAt: string | null
  teamId: number
  teamName: string
  /** How many earlier codes stopped working when this one was issued (E47-S01). */
  revoked?: number
  /** True when this is an existing code read back under audit, not a new one (ADR 0005). */
  revealed?: boolean
}


export const TOKEN_SORTS = ['issued', 'team', 'used'] as const
export type TokenSort = (typeof TOKEN_SORTS)[number]

export const listTokens = (sort?: TokenSort) =>
  get<SubmissionToken[]>(`/submissions/tokens${sort ? `?sort=${sort}` : ''}`)
export const listTeams = () => get<TeamListing[]>('/submissions/teams')

export const issueToken = (
  input: { label: string; teamId?: number; contactEmail?: string; expiresAt?: string },
) => post<IssuedToken>('/submissions/tokens', {
  label: input.label,
  ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
  ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
  ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
})

/**
 * Teams whose names differ from this one only in punctuation, case or a leading "the".
 *
 * Computed here rather than in the browser so there is one definition of "the same name" — the
 * database function the stored column is generated from.
 */
export const similarTeams = (name: string) =>
  get<Team[]>(`/submissions/teams/similar?name=${encodeURIComponent(name)}`)

// ── Registering a cohort from one file (E20) ──────────────────────────────────────────────

export const BULK_OUTCOMES = ['NEW', 'EXISTING', 'INVALID', 'DUPLICATE'] as const
export type BulkOutcome = (typeof BULK_OUTCOMES)[number]

export interface BulkRow {
  line: number
  teamName: string
  contactEmail: string
  outcome: BulkOutcome
  detail: string | null
  teamId: number | null
  /** The plaintext, on a confirmed issue only. The one moment it exists. */
  token: string | null
  tokenId: number | null
}

export interface BulkPlan {
  rows: BulkRow[]
  summary: { total: number; new: number; existing: number; invalid: number; duplicate: number }
  issued: boolean
  refusal: string | null
  /** Present only when delivery was asked for in the same act. */
  delivery?: DeliveryReport
}

/**
 * Ask what a file would do (`confirm: false`), or do it (`confirm: true`).
 *
 * The plan is computed identically either way, so what the operator approved is what runs.
 */
export const bulkTokens = (csv: string, confirm: boolean) =>
  post<BulkPlan>('/submissions/tokens/bulk', { csv, confirm })

/**
 * Issue for every team that has none (E29-S01).
 *
 * No file: once the roster has built the teams there is nothing to assemble, and exporting forty
 * names in order to re-import them would be work the tool invented.
 */
export const tokensForTeams = (confirm: boolean, deliver = false) =>
  post<BulkPlan>('/submissions/tokens/for-teams', { confirm, deliver })

// ── Getting each team its token (E29-S02, E34) ────────────────────────────────────────────

export type DeliveryStatus = 'PREPARED' | 'SENT' | 'FAILED'

export interface DeliveryOutcome {
  teamId: number
  teamName: string
  status: DeliveryStatus
  detail: string
}

export interface PreparedMessage {
  teamName: string
  to: string
  subject: string
  body: string
}

export interface DeliveryReport {
  provider: string
  /** False for an adapter that composes but does not transmit. */
  sends: boolean
  outcomes: DeliveryOutcome[]
  /** The one moment these exist, exactly like the tokens inside them. */
  messages: PreparedMessage[]
}

export interface TeamDelivery {
  teamId: number
  teamName: string
  contactEmail: string
  /** NONE means nothing was attempted — different from something that failed. */
  status: DeliveryStatus | 'NONE'
  attempts: number
  lastError: string | null
  /** The mail service's own id for the message, once it accepted one. */
  providerRef: string | null
  /** What carried the last attempt (E49), and whether the team has a Discord contact at all. */
  channel: 'email' | 'discord' | 'both' | null
  hasDiscord: boolean
  preparedAt: string | null
}

export const getDeliveryState = () => get<TeamDelivery[]>('/submissions/tokens/delivery')

export const revokeToken = (tokenId: number) => del(`/submissions/tokens/${tokenId}`)

export const setSubmissionWindow = (input: {
  name: string; opensAt: string; closesAt: string
}) => post<{ windowId: number }>('/submissions/window', input)

export const lockSubmissionWindow = () => post<unknown>('/submissions/window/lock')
