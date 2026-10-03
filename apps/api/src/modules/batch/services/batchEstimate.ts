/**
 * Wall-clock and cost projection for a batch (E10-S02 acceptance 3, E10-S03 acceptance 3).
 *
 * The rule both of these follow: **an estimate is either measured or absent.** An operator plans
 * around "finishes at 03:00" — they go to bed on it — so a figure invented before anything has
 * been measured is worse than no figure at all. Every function here returns null rather than
 * guessing, and the caller is expected to say "not yet known" rather than print a zero.
 *
 * Medians, not means. One submission that took forty minutes because a repository was enormous
 * should not push the estimate out for the other forty-nine.
 */

export interface StageSample {
  stage: string
  durationMs: number
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

export interface EstimateInput {
  /** Durations measured for this stage, from this run or an earlier one. */
  samples: readonly number[]
  remaining: number
  /** How many run at once — the estimate is wall-clock, not summed work. */
  concurrency: number
}

/**
 * Remaining wall-clock for one stage, in milliseconds, or null when nothing has been measured.
 *
 * Divided by concurrency because the stages run in parallel: reporting the summed work as the
 * wall-clock would tell an operator a four-hour run will take sixteen.
 */
export function remainingMs(input: EstimateInput): number | null {
  const typical = median(input.samples)
  if (typical === null || input.remaining <= 0) return typical === null ? null : 0
  const lanes = Math.max(1, input.concurrency)
  return Math.ceil((typical * input.remaining) / lanes)
}

export function estimatedFinish(
  now: Date, stages: readonly EstimateInput[],
): Date | null {
  let total = 0
  for (const stage of stages) {
    const ms = remainingMs(stage)
    // One unmeasured stage makes the whole estimate unsound: a run that still has to probe
    // fifty repositories cannot be said to finish in the time scoring alone would take.
    if (ms === null) return null
    total += ms
  }
  return new Date(now.getTime() + total)
}

export interface ProjectionInput {
  costSoFarUsd: number
  completed: number
  total: number
  /** Submissions that must have completed before a projection is offered. */
  minimumSamples: number
}

/**
 * Projected total spend, or null before there is enough to project from.
 *
 * Linear in submissions rather than in elapsed time: cost is driven by how many submissions have
 * been scored, and a run that spent twenty minutes scanning before its first model call would
 * otherwise project a total of zero.
 */
export function projectedCost(input: ProjectionInput): number | null {
  if (input.completed < input.minimumSamples || input.completed === 0) return null
  const perSubmission = input.costSoFarUsd / input.completed
  return Math.round(perSubmission * input.total * 1e6) / 1e6
}

export interface CeilingCheck {
  costSoFarUsd: number
  projectedUsd: number | null
  ceilingUsd: number
}

export type CeilingVerdict =
  | { action: 'CONTINUE' }
  | { action: 'PAUSE'; reason: string }

/**
 * Whether the run may continue (E10-S03 acceptance 2).
 *
 * Pauses on the actual spend crossing the ceiling, and ALSO on a projection that crosses it —
 * the second is the useful one. Waiting for actual spend to reach the ceiling means stopping
 * after the money is gone; a projection stops the run while an operator can still decide whether
 * to raise the ceiling or cut the cohort.
 */
export function ceilingVerdict(input: CeilingCheck): CeilingVerdict {
  if (input.costSoFarUsd >= input.ceilingUsd) {
    return {
      action: 'PAUSE',
      reason:
        `Spend has reached $${input.costSoFarUsd.toFixed(2)}, at or above the $` +
        `${input.ceilingUsd.toFixed(2)} ceiling. The run is paused rather than cancelled: the ` +
        `work already done is kept, and resuming after raising the ceiling continues from here.`,
    }
  }

  if (input.projectedUsd !== null && input.projectedUsd > input.ceilingUsd) {
    return {
      action: 'PAUSE',
      reason:
        `At the current rate this run would cost about $${input.projectedUsd.toFixed(2)}, above ` +
        `the $${input.ceilingUsd.toFixed(2)} ceiling. It is paused now, with $` +
        `${input.costSoFarUsd.toFixed(2)} spent, so the ceiling can be raised or the cohort ` +
        `reduced before the rest is spent.`,
    }
  }

  return { action: 'CONTINUE' }
}
