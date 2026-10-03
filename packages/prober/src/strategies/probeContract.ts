/**
 * The one contract every build method implements (P1.5 clause 1).
 *
 * Build method is a declared variant axis. Adding one — a devcontainer, a Nix flake — is one
 * strategy file plus one registry line, and the sandbox policy applies to all of them because
 * containment lives outside the strategies rather than inside each.
 */
import { captureLog } from '../logCapture.js'
import type { ProbeInput, ProbeResult } from '../types.js'

export interface ProbeStrategy {
  readonly method: ProbeInput['buildMethod']
  /** Whether this strategy can run the submission as declared, and why not if it cannot. */
  canRun(input: ProbeInput): { ok: true } | { ok: false; reason: string }
  run(input: ProbeInput, context: ProbeContext): Promise<ProbeResult>
}

export interface ProbeContext {
  /** Unique, correlation-tagged name for anything the probe creates. */
  handle: string
  /** Registers something for guaranteed teardown, whatever the outcome. */
  onCleanup: (fn: () => Promise<void>) => void
}

export function emptyResult(input: ProbeInput): ProbeResult {
  return {
    outcome: 'PROBE_ERROR',
    method: input.buildMethod,
    buildExitCode: null,
    buildDurationMs: 0,
    stayedUp: false,
    runDurationMs: 0,
    timedOut: false,
    resourceExceeded: false,
    log: '',
    logTruncated: false,
    logBytes: 0,
    egressAllowed: input.policy.egressAllowList,
    baseImage: null,
    probeError: null,
    ranAt: new Date().toISOString(),
    totalDurationMs: 0,
  }
}

/**
 * Did the container die because it hit a limit?
 *
 * Exit 137 is SIGKILL, which is what the OOM killer and a PID-limit kill both look like. It is
 * reported as `RESOURCE_EXCEEDED` rather than as a build failure, because those are different
 * facts about a submission and a reviewer needs to tell them apart.
 */
export function hitResourceLimit(exitCode: number | null, output: string): boolean {
  if (exitCode === 137) return true
  return /out of memory|oom-killed|cannot fork|resource temporarily unavailable/i.test(output)
}

/**
 * Attach the captured log and total duration to a result.
 *
 * Shared by every strategy: both had an identical five-argument copy, which is two places to
 * change when log handling changes and two chances to get it wrong.
 */
export function withLog(input: {
  result: ProbeResult
  buildOutput: string
  runOutput: string
  capBytes: number
  startedAt: number
}): ProbeResult {
  const captured = captureLog(input.buildOutput, input.runOutput, input.capBytes)
  input.result.log = captured.text
  input.result.logTruncated = captured.truncated
  input.result.logBytes = captured.originalBytes
  input.result.totalDurationMs = Date.now() - input.startedAt
  return input.result
}
