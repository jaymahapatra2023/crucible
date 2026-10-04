/**
 * Participants confirming their own details (migration 104).
 *
 * The public call is anonymous and returns one fixed sentence. The other two are organiser-only
 * and carry names and addresses, so they go through the authenticated client.
 */
import { get, post, postPublic } from './apiClient.js'

export interface ClaimOutcome {
  received: boolean
  message: string
}

export interface Correction {
  correctionId: number
  claimedName: string
  claimedEmail: string
  participantId: number | null
  currentName: string | null
  currentEmail: string | null
  organisation: string | null
  matched: boolean
  /** What approving would do, worked out from the match rather than stored. */
  kind: 'ADD' | 'CORRECTION'
  onATeam: boolean
  status: 'PENDING' | 'APPLIED' | 'REJECTED'
  createdAt: string
}

export interface DecisionOutcome {
  correctionId: number
  status: 'APPLIED' | 'REJECTED'
  effect: 'CORRECTED' | 'ADDED' | 'NONE'
  participantId: number | null
  detail: string
}

/** Anonymous. Says the same thing whoever asks, which is why it can be public. */
export const submitConfirmation = (input: { fullName: string; email: string }) =>
  postPublic<ClaimOutcome>('/confirm', input)

export const getCorrections = (status?: Correction['status']) =>
  get<Correction[]>(`/roster/corrections${status ? `?status=${status}` : ''}`)

export const decideCorrection = (correctionId: number, approve: boolean) =>
  post<DecisionOutcome>(`/roster/corrections/${correctionId}`, { approve })
