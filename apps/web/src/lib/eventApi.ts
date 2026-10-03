/** Event setup and the provenance queue (E19). */
import { get, patch, post } from './apiClient.js'

export interface EventSettings {
  evaluationDate: string | null
  window: { startsAt: string; endsAt: string } | null
  dryRunLeadDays: number
  /** The public links (E50): what the emails carry and what the QR codes encode. */
  registerUrl: string | null
  submitUrl: string | null
  discordInviteUrl: string | null
}

export interface FlaggedProvenance {
  submission_id: number
  scan_id: number
  total_commits: number
  commits_out_of_window: number
  distinct_authors: number
  largest_single_commit_pct: number
  history_truncated: boolean
  flags: Array<{ code: string; message: string }>
  /** Set once a person has looked and recorded what they concluded. */
  resolved?: boolean
  resolution_reason?: string | null
  resolved_by?: string | null
}

export const getEventSettings = () => get<EventSettings>('/platform/event')

export const setEvaluationDate = (evaluationDate: string) =>
  patch<EventSettings>('/platform/config/event.evaluation_date', { value: evaluationDate })

/** Two config writes, admin-only, so the QR codes and the emails agree on the address. */
export const setEventUrls = async (urls: { registerUrl: string; submitUrl: string }) => {
  await patch('/platform/config/event.register_url', { value: urls.registerUrl })
  await patch('/platform/config/event.submit_url', { value: urls.submitUrl })
}

export const setEventWindow = (startsAt: string, endsAt: string) =>
  patch<EventSettings>('/platform/config/scans.event_window', {
    value: { startsAt, endsAt },
  })

export const getFlaggedProvenance = () =>
  get<FlaggedProvenance[]>('/scans/provenance/flagged')

export const resolveProvenance = (submissionId: number, reason: string) =>
  post<{ submissionId: number; resolved: boolean }>(
    `/scans/provenance/${submissionId}/resolve`, { reason })
