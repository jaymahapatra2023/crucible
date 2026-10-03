/** System readiness API surface (plan §IV.5). */
import { get } from './apiClient.js'

export interface ReadinessCheck {
  id: string
  statement: string
  status: 'PASS' | 'FAIL' | 'UNKNOWN'
  /** What was found, not merely whether it passed. */
  detail: string
}

export interface ReadinessReport {
  cohortKey: string
  ready: boolean
  checks: ReadinessCheck[]
}

export const getReadiness = (cohortKey: string) =>
  get<ReadinessReport>(`/platform/readiness/${encodeURIComponent(cohortKey)}`)
