/**
 * Pre-flight (E46) and team administration (E47-S01, E48-S01) calls, split from `intakeApi` so
 * that file stays within its size limit (P1.4).
 */
import { patchJson, post } from './apiClient.js'
import type { IssuedToken, Team } from './intakeApi.js'

export type PreflightStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
export type PreflightVerdict = 'READY' | 'PROBLEMS' | 'UNKNOWN'
export type NoticeStatus = 'SENT' | 'PREPARED' | 'FAILED' | 'UNCHANGED'

export interface PreflightSummary {
  preflightId: number
  status: PreflightStatus
  verdict: PreflightVerdict | null
  commitSha: string | null
  /** The non-passing checks, named, so a row says WHAT is wrong (E46-S02 acceptance 4). */
  attention: Array<{ key: string; label: string; status: 'FAIL' | 'UNKNOWN' }>
  error: string | null
  noticeStatus: NoticeStatus | null
  finishedAt: string | null
}

/** Queue the asynchronous checks for one entry (E46-S02 acceptance 2). 202: queued, not done. */
export const runPreflight = (submissionId: number, force = false) =>
  post<{ preflightId: number; status: PreflightStatus; joined: boolean; message: string }>(
    `/preflight/submissions/${submissionId}/run`, { force })

/** Replace a team's code: the old one is revoked and the new plaintext shown once (E47-S01). */
export const reissueToken = (teamId: number, reason: string) =>
  post<IssuedToken>(`/submissions/teams/${teamId}/reissue`, { reason })

/** Correct a team's name or contact (E48-S01). Entries keep the name they were made under. */
export const updateTeam = (teamId: number, patch: { displayName?: string; contactEmail?: string }) =>
  patchJson<Team>(`/submissions/teams/${teamId}`, patch)

export type RevealOutcome =
  | { available: true; tokenId: number; teamId: number; teamName: string; token: string; revealedAt: string }
  | { available: false; tokenId: number; teamId: number | null; teamName: string | null; reason: string }

/** Read a team's current code back, audited under the caller's name. Admin only (ADR 0005). */
export const revealToken = (tokenId: number) =>
  post<RevealOutcome>(`/submissions/tokens/${tokenId}/reveal`)
