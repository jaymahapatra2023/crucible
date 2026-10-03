/**
 * Pre-flight port (P1.2, P1.3, ADR 0002).
 *
 * A submission that passes tier 1 should be queued for the asynchronous checks (E46-S02
 * acceptance 1). The queue belongs to the **preflight** module, which sits above submissions —
 * it calls scan, probe and discovery — so submissions cannot import it without a cycle. It asks
 * through this interface instead, and preflight registers the implementation at boot.
 *
 * **Unregistered, it is a loud no-op** like the logistics port, not a throw like the team port.
 * A pre-flight run is advisory and blocks nothing (E46-S01 acceptance 6); a submission that
 * failed to be accepted because nobody had wired the checks would be the one thing the checks
 * exist to prevent.
 */
import { createLogger } from '../logger.js'

const log = createLogger('platform', 'preflightPort')

export interface PreflightPort {
  /** Queue a run. Idempotent: a submission with a run already queued or running joins it. */
  enqueue(input: { submissionId: number; triggeredBy: string }): Promise<void>
}

const unregistered: PreflightPort = {
  async enqueue(input) {
    log.warn('no preflight port is registered; the submission will not be pre-flighted', {
      submissionId: input.submissionId,
    })
  },
}

let impl: PreflightPort = unregistered

export function registerPreflightPort(port: PreflightPort): void {
  impl = port
}

/** Test seam — restores the unregistered implementation. */
export function resetPreflightPort(): void {
  impl = unregistered
}

export const preflight = (): PreflightPort => impl
