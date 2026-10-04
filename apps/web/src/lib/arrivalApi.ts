/**
 * Coaches confirming they are at the venue (migration 105).
 */
import { get, getPublic, postPublic } from './apiClient.js'

export interface CoachArrival {
  coachId: number
  fullName: string
  email: string
  organisation: string | null
  teamCapacity: number | null
  arrivedAt: string | null
  arrived: boolean
  teamsAssigned: number
  /** Teams with nobody, because this coach has not confirmed. Zero once they have. */
  teamsUncovered: number
}

export interface ArrivalSummary {
  coaches: CoachArrival[]
  summary: { total: number; arrived: number; missing: number; teamsUncovered: number }
}

/** Names only, for the public page to offer. */
export const getCoachNames = () => getPublic<string[]>('/coach/names')

export const confirmArrival = (fullName: string) =>
  postPublic<{ received: boolean; message: string }>('/coach/confirm', { fullName })

export const getArrivals = () => get<ArrivalSummary>('/roster/arrivals')
