/** Batch run API surface (E10). */
import { get, post } from './apiClient.js'

export interface StageProgress {
  stage: 'scan' | 'probe' | 'score'
  ok: number
  failed: number
  skipped: number
  done: number
}

export interface BatchProgress {
  runId: number
  status: string
  startedAt: string
  finishedAt: string | null
  costUsd: number
  /** Null until measured — never a guess (E10-S02 acceptance 3). */
  estimatedFinishAt: string | null
  projectedCostUsd: number | null
  currentStage: string | null
  currentSubject: string | null
  currentLabel: string | null
  completed: number
  total: number
  stages: StageProgress[]
  failures: Array<{ stage: string; subjectId: string | null; message: string }>
  /** Set when the run stopped for a reason an operator has to act on. */
  pausedReason: string | null
  /** Spend attributed to each submission, dearest first, including failed attempts. */
  costBySubmission: Array<{
    submissionId: string; costUsd: number; calls: number; failedCalls: number
  }>
}

export interface StartedBatch {
  runId: number
  scoreRunId: number
  subjects: number
  /** Quoted before the run begins, or null when nothing comparable has been measured. */
  estimatedFinishAt: string | null
  correlationId: string
  message: string
}

export const getBatchProgress = (runId: number) =>
  get<BatchProgress>(`/batch/runs/${runId}/progress`)

export const startBatch = (input: {
  challengeIds: number[]
  cohortKey: string
  runIndex: 1 | 2
  force?: boolean
}) => post<StartedBatch>('/batch/runs', input)
