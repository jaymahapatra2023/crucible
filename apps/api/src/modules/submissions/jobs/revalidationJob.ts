/**
 * Scheduled re-validation of submitted repositories (E03-S02 acceptance 4, risk R8).
 *
 * A repository that was public at submit time and is private on evaluation night is the failure
 * this job exists to catch. Catching it at 02:00 on the night is an incident; catching it the
 * afternoon before is an email.
 *
 * The job stops doing work once intake is locked — after the lock the evaluated commit is
 * already recorded, so re-checking would change nothing and would keep cloning fifty
 * repositories for no reason.
 */
import { createLogger } from '../../../lib/logger.js'
import { scheduleTask } from '../../platform/jobs/scheduler.js'
import { isEnabled } from '../../platform/services/configService.js'
import { revalidateDue } from '../services/submissionService.js'
import { intakeStatus } from '../services/windowService.js'

const log = createLogger('submissions', 'revalidationJob')

export const REVALIDATION_TASK = 'submissions.revalidate'

/** How often to tick. The per-submission staleness threshold is separate configuration. */
const TICK_MS = 5 * 60 * 1000

export async function revalidationTick(): Promise<{
  skipped?: string; checked?: number; regressed?: number
}> {
  if (!(await isEnabled('feature.submissions.revalidation'))) {
    return { skipped: 'revalidation disabled' }
  }

  const status = await intakeStatus()
  if (status.state === 'LOCKED' || status.state === 'NO_WINDOW') {
    return { skipped: `intake is ${status.state}` }
  }

  const result = await revalidateDue()
  if (result.regressed > 0) {
    // Surfaced loudly: a submission that stopped validating needs a person to chase it.
    log.warn('submissions stopped validating since their last check', {
      checked: result.checked, regressed: result.regressed,
    })
  }
  return result
}

export function installRevalidationJob(): void {
  scheduleTask({
    name: REVALIDATION_TASK,
    intervalMs: TICK_MS,
    run: revalidationTick,
  })
}
