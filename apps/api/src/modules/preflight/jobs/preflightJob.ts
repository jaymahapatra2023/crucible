/**
 * Draining the pre-flight queue (E46-S02).
 *
 * Every tick: abandon runs whose process died, then claim and run what is queued, bounded by
 * `preflight.concurrency`. An enqueue also kicks a drain at once, so a submission's checks start
 * within a second rather than at the next tick; the tick is what catches up after a restart.
 */
import { scheduleTask } from '../../platform/jobs/scheduler.js'
import { drainPreflight, failStaleRuns, setAutoDrain } from '../services/preflightOrchestrator.js'

export const PREFLIGHT_TASK = 'preflight.drain'

const TICK_MS = 15 * 1000

export async function preflightTick(): Promise<{ failed: number; claimed: number }> {
  const { failed } = await failStaleRuns()
  const { claimed } = await drainPreflight()
  return { failed, claimed }
}

export function installPreflightJob(): void {
  setAutoDrain(true)
  scheduleTask({ name: PREFLIGHT_TASK, intervalMs: TICK_MS, run: preflightTick })
}
