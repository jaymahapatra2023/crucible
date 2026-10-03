/**
 * Periodic task scheduler.
 *
 * Crucible has a handful of recurring jobs — re-validating submissions until the window closes
 * is the first — and no queue infrastructure. Rather than pull one in, tasks register here and
 * run on an interval inside the API process.
 *
 * Two properties keep that honest against P11.4 (stateless services):
 *
 *  - **Every task must be idempotent and safe to run concurrently.** Two API instances will both
 *    tick. Duplicated work is acceptable; incorrect results are not, so a task that cannot meet
 *    this bar does not belong here.
 *  - **No state lives here that matters.** The scheduler holds timers. Everything a task decides
 *    is read from and written to the database, so a restart loses nothing but a tick.
 *
 * Recorded as a deliberate simplification in the module's TECH_DEBT.md: when a second instance
 * or a heavier job appears, this is replaced by a real queue with leader election.
 */
import { createLogger } from '../../../lib/logger.js'
import { newCorrelationId, withCorrelation } from '../../../lib/correlation.js'
import { errorMessage } from '../../../lib/appError.js'

const log = createLogger('platform', 'scheduler')

export interface ScheduledTask {
  name: string
  /** How often to run, in milliseconds. Read once at registration. */
  intervalMs: number
  /** Must be idempotent and safe to run alongside another instance's copy. */
  run: () => Promise<unknown>
}

interface Registered extends ScheduledTask {
  timer: NodeJS.Timeout
  running: boolean
  runs: number
  failures: number
  lastError: string | null
  lastRunAt: Date | null
}

const tasks = new Map<string, Registered>()

export function scheduleTask(task: ScheduledTask): void {
  if (tasks.has(task.name)) {
    log.warn('task already scheduled; ignoring duplicate registration', { task: task.name })
    return
  }

  const entry: Registered = {
    ...task,
    timer: setInterval(() => void tick(task.name), task.intervalMs),
    running: false,
    runs: 0,
    failures: 0,
    lastError: null,
    lastRunAt: null,
  }
  // Never hold the process open for a timer — a scheduled task must not prevent shutdown.
  entry.timer.unref()
  tasks.set(task.name, entry)

  log.info('task scheduled', { task: task.name, intervalMs: task.intervalMs })
}

/**
 * Run one tick.
 *
 * A still-running task is skipped rather than overlapped: revalidation clones repositories, and
 * a slow pass overlapping itself would multiply outbound load exactly when the host is slow.
 */
async function tick(name: string): Promise<void> {
  const task = tasks.get(name)
  if (!task || task.running) return

  task.running = true
  task.lastRunAt = new Date()

  try {
    await withCorrelation({ correlationId: newCorrelationId() }, async () => {
      const result = await task.run()
      task.runs++
      log.debug('scheduled task completed', { task: name, result })
    })
    task.lastError = null
  } catch (err) {
    task.failures++
    task.lastError = errorMessage(err)
    // A failing scheduled task must not take the process down, but must be visible (P9.4).
    log.error('scheduled task failed', { task: name, err })
  } finally {
    task.running = false
  }
}

/** Run a task now, outside its schedule. Used by the manual trigger and by tests. */
export async function runTaskNow(name: string): Promise<void> {
  await tick(name)
}

export interface TaskStatus {
  name: string
  intervalMs: number
  running: boolean
  runs: number
  failures: number
  lastError: string | null
  lastRunAt: Date | null
}

export function taskStatus(): TaskStatus[] {
  return [...tasks.values()].map((t) => ({
    name: t.name, intervalMs: t.intervalMs, running: t.running,
    runs: t.runs, failures: t.failures, lastError: t.lastError, lastRunAt: t.lastRunAt,
  }))
}

export function stopAllTasks(): void {
  for (const task of tasks.values()) clearInterval(task.timer)
  tasks.clear()
}
