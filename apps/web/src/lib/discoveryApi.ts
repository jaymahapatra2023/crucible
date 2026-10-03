/** What a submission IS, as distinct from how well it scores (E12). */
import { get, post } from './apiClient.js'

export type ConcernOutcome = 'FOUND' | 'NONE_FOUND' | 'INSUFFICIENT_EVIDENCE' | 'FAILED'

export interface DiscoveryTile {
  key: string
  label: string
  /** Null where a number would be a false statement — a gap, not a zero. */
  count: number | null
  outcome: ConcernOutcome
  warn: boolean
  note: string
}

export interface Finding {
  finding_id: number
  kind: string
  label: string
  summary: string
  detail: Record<string, unknown>
  path: string
  line_start: number | null
  line_end: number | null
  excerpt: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  /**
   * Whether a reviewer has checked this and set it aside (E16-S03).
   *
   * A dismissed observation stays VISIBLE and marked. Hiding it would make a checked one and an
   * unexamined one look identical, which is the confusion the tile design works hardest to
   * avoid everywhere else.
   */
  dismissed?: boolean
  dismissal_reason?: string | null
  dismissed_by?: string | null
}

export interface Conflict {
  conflict_id: number
  claim: string
  claim_path: string
  claim_line: number | null
  expected: string
  observed: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

export interface Discovery {
  status: 'ABSENT' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  discoveryId: number | null
  commitSha: string | null
  scanId: number | null
  model: string | null
  costUsd: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  tiles: DiscoveryTile[]
  findings: Record<string, Finding[]>
  conflicts: Conflict[]
  gaps: Array<{ key: string; label: string; outcome: ConcernOutcome; note: string }>
  runtime: { containerised: boolean; entrypoint: string; notes: string } | null
}

export interface Concern {
  key: string
  name: string
  description: string
  kind: string | null
  emptyIsMeaningful: boolean
}

export const getDiscovery = (submissionId: string | number) =>
  get<Discovery>(`/submissions/${submissionId}/discovery`)

export const runDiscovery = (submissionId: string | number) =>
  post<{ discoveryId: number; usable: boolean }>(`/submissions/${submissionId}/discovery`, {})

export const getConcerns = () => get<Concern[]>('/discovery/concerns')

export interface DiscoveryChanges {
  comparable: boolean
  previousDiscoveryId: number | null
  added: Array<{ kind: string; label: string; path: string; summary: string }>
  unchanged: number
  disappeared: Array<{ kind: string; label: string; path: string; summary: string }>
  resolvedSecurity: Array<{ kind: string; label: string; path: string; summary: string }>
  note: string
}

export const getChanges = (submissionId: string | number) =>
  get<DiscoveryChanges>(`/submissions/${submissionId}/discovery/changes`)

export const dismissFinding = (findingId: number, reason: string) =>
  post<{ findingId: number; dismissed: boolean }>(
    `/discovery/findings/${findingId}/dismiss`, { reason })

export const reinstateFinding = (findingId: number) =>
  post<{ findingId: number; dismissed: boolean }>(
    `/discovery/findings/${findingId}/reinstate`, {})

/** The kinds a findings list is grouped under, in the order the page presents them. */
export const FINDING_KINDS = [
  'STACK', 'ENDPOINT', 'ENTITY', 'CAPABILITY', 'INTEGRATION', 'SECURITY',
] as const

export const KIND_TITLES: Record<string, string> = {
  STACK: 'Technology stack',
  ENDPOINT: 'API surface',
  ENTITY: 'Data model',
  CAPABILITY: 'Capabilities',
  INTEGRATION: 'External systems',
  SECURITY: 'Security observations',
}
