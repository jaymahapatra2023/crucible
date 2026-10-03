/**
 * Prober types (E05).
 *
 * The Runs dimension is the one objective score in the rubric: it is derived from what actually
 * happened when the submission was built and started. **No model participates** (E05-S04
 * acceptance 3), so these types describe observations, never judgements.
 */

export const BUILD_METHODS = ['DOCKERFILE', 'COMMAND'] as const
export type BuildMethod = (typeof BUILD_METHODS)[number]

/**
 * The outcome of a probe, in the four states E05-S04 acceptance 2 names, plus the honest
 * "we could not tell" states.
 */
export const PROBE_OUTCOMES = [
  /** Built and stayed up for the settle period. */
  'RUNS',
  /** Built, but exited or crashed before the settle period elapsed. */
  'BUILDS_ONLY',
  /** The build itself failed. */
  'BUILD_FAILED',
  /** No base image matches the stack — not the team's fault (E05-S03 acceptance 3). */
  'UNSUPPORTED_STACK',
  /** The probe exceeded its wall-clock limit. */
  'TIMED_OUT',
  /** The probe hit a CPU, memory or PID limit. */
  'RESOURCE_EXCEEDED',
  /** The harness itself failed. Never counted against the submission. */
  'PROBE_ERROR',
] as const
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number]

export interface SandboxPolicy {
  /** Hard wall-clock limit for the whole probe. */
  timeoutMs: number
  /** Seconds the container must stay up to count as running. */
  settleSeconds: number
  memoryMb: number
  cpus: number
  pidsLimit: number
  /** Bytes of combined stdout/stderr retained (E05-S02 acceptance 3). */
  logCapBytes: number
  /**
   * Hosts egress is permitted to, if any. Empty means no network at all, which is the default.
   * Whatever is allowed is recorded on the probe (E05-S01 acceptance 3).
   */
  egressAllowList: readonly string[]
}

export interface ProbeInput {
  /** A local checkout of the submission. Copied into the container; never mounted. */
  repoPath: string
  buildMethod: BuildMethod
  /** Repository-relative path, for DOCKERFILE. */
  dockerfilePath?: string
  /** Single command, for COMMAND. */
  buildCommand?: string
  /** Detected language, used to pick a base image for the COMMAND path. */
  language?: string
  policy: SandboxPolicy
  /** Correlates container names and logs with the run that caused them (P9.2). */
  correlationId?: string
}

export interface ProbeResult {
  outcome: ProbeOutcome
  method: BuildMethod
  /** Exit code of the build step, where one ran. */
  buildExitCode: number | null
  buildDurationMs: number
  /** Whether the container stayed up for the settle period. */
  stayedUp: boolean
  runDurationMs: number
  timedOut: boolean
  resourceExceeded: boolean
  /** Combined output, truncated to the cap, with truncation stated (acceptance 3). */
  log: string
  logTruncated: boolean
  logBytes: number
  /** Egress actually permitted, recorded so a later reader knows what the build could reach. */
  egressAllowed: readonly string[]
  /** Base image used on the COMMAND path. */
  baseImage: string | null
  /** Set when the harness failed, as distinct from the submission failing. */
  probeError: string | null
  ranAt: string
  totalDurationMs: number
}

/** The four states E05-S04 acceptance 2 derives the dimension score from. */
export type RunsGrade = 'RUNS' | 'BUILDS_ONLY' | 'FAILS_TO_BUILD' | 'UNSUPPORTED'
