/**
 * Run ledger types (E01-S05). Module-local — the cross-module contract is the
 * `v_platform_run_progress` view and the `/api/v1/platform/runs` endpoints (P1.3).
 */

export const RUN_KINDS = [
  'SCAN', 'PROBE', 'SCORE', 'COHORT', 'CALIBRATION', 'DRY_RUN', 'DISCOVERY', 'PREFLIGHT',
] as const
export type RunKind = (typeof RUN_KINDS)[number]

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** The four outcomes E01-S05 acceptance 1 requires. */
export const STAGE_OUTCOMES = ['ok', 'failed', 'skipped', 'warning'] as const
export type StageOutcome = (typeof STAGE_OUTCOMES)[number]

export interface Run {
  runId: number
  kind: RunKind
  status: RunStatus
  params: Record<string, unknown>
  pinnedConfig: Record<string, unknown>
  correlationId: string
  startedBy: string | null
  startedAt: Date
  finishedAt: Date | null
  costUsd: number
  error: string | null
}

export interface StageResult {
  id: number
  runId: number
  stage: string
  subjectType: string
  subjectId: string | null
  outcome: StageOutcome
  message: string | null
  detail: Record<string, unknown>
  attempt: number
  startedAt: Date
  finishedAt: Date | null
  durationMs: number | null
}

export interface RunProgress {
  runId: number
  kind: RunKind
  status: RunStatus
  startedAt: Date
  finishedAt: Date | null
  costUsd: number
  stageResults: number
  okCount: number
  failedCount: number
  skippedCount: number
  warningCount: number
}

/** What `GET /runs/:id` returns — current state without reading logs (E01-S05 acceptance 3). */
export interface RunDetail {
  run: Run
  progress: RunProgress
  stages: StageResult[]
}
