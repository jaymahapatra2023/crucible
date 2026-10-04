/**
 * Probe orchestration (E05-S01, E05-S04).
 *
 * Owns the two guarantees that must hold regardless of which strategy runs:
 *
 *  - **Everything the probe created is destroyed**, whatever the outcome (acceptance 1). Fifty
 *    untrusted repositories per run makes a leaked container or image a real operational
 *    problem, and a leaked *running* container is a security one.
 *  - **A harness failure is never scored against a submission.** `PROBE_ERROR` and
 *    `UNSUPPORTED_STACK` are distinct from `BUILD_FAILED`, because a team cannot fix our runtime.
 */
import { randomUUID } from 'node:crypto'
import { runtimeAvailable } from './containerRuntime.js'
import { assertPolicySafe, DEFAULT_POLICY } from './sandboxPolicy.js'
import { describeBlock } from './sandboxSignatures.js'
import { strategyFor } from './strategies/strategyRegistry.js'
import { emptyResult } from './strategies/probeContract.js'
import type { ProbeInput, ProbeResult, RunsGrade } from './types.js'

export async function probe(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now()

  // Validated before anything runs: a misconfigured policy is the failure that turns this from
  // a sandbox into a shell on the host, and it would not announce itself (P8.6).
  assertPolicySafe(input.policy)

  const result = emptyResult(input)
  const cleanups: Array<() => Promise<void>> = []

  try {
    if (!(await runtimeAvailable())) {
      result.outcome = 'PROBE_ERROR'
      result.probeError =
        'No container runtime is available, so the submission could not be built. This is a ' +
        'harness problem and must not be scored against the team.'
      result.totalDurationMs = Date.now() - started
      return result
    }

    const strategy = strategyFor(input.buildMethod)
    if (!strategy) {
      result.outcome = 'PROBE_ERROR'
      result.probeError = `No probe strategy is registered for '${input.buildMethod}'.`
      result.totalDurationMs = Date.now() - started
      return result
    }

    const feasible = strategy.canRun(input)
    if (!feasible.ok) {
      // A stack we cannot build is recorded as unsupported, not as a failure to build
      // (E05-S03 acceptance 3).
      result.outcome = 'UNSUPPORTED_STACK'
      result.probeError = feasible.reason
      result.totalDurationMs = Date.now() - started
      return result
    }

    return await strategy.run(input, {
      handle: `${(input.correlationId ?? randomUUID()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}-${randomUUID().slice(0, 8)}`,
      onCleanup: (fn) => cleanups.push(fn),
    })
  } catch (err) {
    result.outcome = 'PROBE_ERROR'
    result.probeError = err instanceof Error ? err.message : String(err)
    result.totalDurationMs = Date.now() - started
    return result
  } finally {
    // Always, in reverse order, and one failure never prevents the rest (acceptance 1).
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => undefined)
    }
  }
}

/**
 * The Runs dimension score, derived **deterministically** from the probe (E05-S04 acceptance 2).
 *
 * No model participates in this dimension (acceptance 3). That is the whole point: in a rubric
 * where everything else is a judgement, one dimension is a measurement, and it stays a
 * measurement.
 */
export function gradeRuns(result: ProbeResult): { grade: RunsGrade; score: number; reason: string } {
  switch (result.outcome) {
    case 'RUNS':
      return {
        grade: 'RUNS', score: 4,
        reason: `Built and stayed up for the settle period (exit code ${result.buildExitCode ?? 0}).`,
      }
    case 'SANDBOX_BLOCKED':
      // Three of four, which is 75 of 100 after `toHundred`. A deduction, not an exemption:
      // the environment is documented, and a build that does not start in it is still the
      // team's to own — but it is nothing like the crash that BUILDS_ONLY describes.
      return {
        grade: 'BLOCKED_BY_SANDBOX', score: 3,
        reason: result.sandboxBlock
          ? describeBlock(result.sandboxBlock)
          : 'The sandbox denied something the application needed.',
      }
    case 'BUILDS_ONLY':
      return {
        grade: 'BUILDS_ONLY', score: 2,
        reason: 'Built successfully but did not stay running for the settle period.',
      }
    case 'BUILD_FAILED':
      return {
        grade: 'FAILS_TO_BUILD', score: 0,
        reason: `The build failed with exit code ${result.buildExitCode ?? 'unknown'}.`,
      }
    case 'TIMED_OUT':
      return {
        grade: 'FAILS_TO_BUILD', score: 0,
        reason: 'The build exceeded the time limit.',
      }
    case 'RESOURCE_EXCEEDED':
      return {
        grade: 'FAILS_TO_BUILD', score: 0,
        reason: 'The build exceeded the memory, CPU or process limit.',
      }
    case 'UNSUPPORTED_STACK':
    case 'PROBE_ERROR':
      // Scored as UNSUPPORTED, not zero. E07-S01 excludes it from the denominator rather than
      // treating it as a failure the team caused.
      return {
        grade: 'UNSUPPORTED', score: -1,
        reason: result.probeError ?? 'The probe could not run this submission.',
      }
  }
}

export { DEFAULT_POLICY }
