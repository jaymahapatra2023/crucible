/**
 * Handing every registered team its submission code, once (migration 103).
 *
 * Its own file rather than another export on `intakeApi`, which is at its line budget (P1.4).
 */
import { post } from './apiClient.js'
import type { DeliveryReport } from './intakeApi.js'

/** One row per registered team, and whether it has been sent its code. */
export interface HandoutRow {
  teamId: number
  teamName: string
  contactEmail: string
  state: 'WAITING' | 'SENT' | 'BLOCKED'
  detail: string | null
}

export interface HandoutPlan {
  rows: HandoutRow[]
  summary: { total: number; waiting: number; alreadySent: number; blocked: number }
  report: DeliveryReport | null
}

export const handOutCodes = (confirm: boolean) =>
  post<HandoutPlan>('/submissions/codes/hand-out', { confirm })
