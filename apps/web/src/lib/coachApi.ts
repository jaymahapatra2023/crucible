/**
 * Coach sheets (E51): what the evaluation found about a shortlisted team, as questions.
 */
import { get, post } from './apiClient.js'

export interface CoachQuestion {
  topic: 'RUN' | 'CLAIM' | 'CRITERION' | 'ORIGINALITY' | 'PROVENANCE' | 'DISAGREEMENT' | 'SECURITY' | 'PRINCIPLE' | 'STANDARD'
  because: string
  ask: string
  evidence: string | null
}

export interface CoachSheet {
  submissionId: number
  teamId: number | null
  teamName: string
  challenge: string
  members: string[]
  room: string | null
  coach: string | null
  repoUrl: string
  commit: string | null
  standing: { rankInRun: number | null; finalRank: number | null; decision: string | null }
  built: { stack: string[]; capabilities: string[]; endpoints: number; integrations: string[]; runtime: string | null; absent: boolean }
  ran: { outcome: string; reason: string } | null
  strengths: string[]
  questions: CoachQuestion[]
  confidential: string
}

export interface CoachDispatch {
  dispatchId: number
  coachId: number
  teamIds: number[]
  status: 'SENT' | 'PREPARED' | 'FAILED'
  detail: string | null
  sentAt: string
}

export type SheetScope = 'shortlist' | 'cutline'

export const getCoachSheets = (runId: number, scope: SheetScope) =>
  get<{ scope: SheetScope; sheets: CoachSheet[]; dispatches: CoachDispatch[] }>(`/review/runs/${runId}/coach-sheets?scope=${scope}`)
export const getCoachSheet = (runId: number, submissionId: number) =>
  get<CoachSheet>(`/review/runs/${runId}/teams/${submissionId}/coach-sheet`)
export const sendCoachSheets = (runId: number, scope: SheetScope) =>
  post<{ sent: CoachDispatch[]; uncoached: string[] }>(`/review/runs/${runId}/coach-sheets/send?scope=${scope}`)
