/**
 * Pre-flight: everything that needs minutes, run after the submission request has returned
 * (E46-S01, E46-S02).
 *
 * An orchestrator in the batch module's sense: it sequences scan → probe → discovery → secrets
 * through the same services the cohort run calls, and owns only the policy around them —
 * bounded concurrency, a recorded failure for a run that dies, a verdict that blocks nothing.
 *
 * Three decisions shape it:
 *
 *  - **The database is the queue.** A QUEUED row is claimed with SKIP LOCKED; a run is never
 *    held in process memory, so a restart loses nothing but a tick (P11.4).
 *  - **UNKNOWN is never FAIL** (acceptance 3). A check FAILS only on a recorded outcome about the
 *    team's repository; a service that threw is the harness, and the team is told "could not be
 *    checked".
 *  - **Nothing here runs inside a request or an evaluation** (acceptance 5). The port enqueues;
 *    the scheduler drains; the batch orchestrator never calls this.
 */
import { mapWithLimit } from '../../../lib/pool.js'
import { errorMessage } from '../../../lib/appError.js'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { registerPreflightPort } from '../../../lib/ports/preflightPort.js'
import { withRunPin, type RunPin } from '../../../lib/runScope.js'
import { queryOne } from '../../../db/pool.js'
import { captureRunPin, getNumber, isEnabled } from '../../platform/services/configService.js'
import { closeRun, openRun, stage, stageOutcome } from '../../platform/services/runLedgerService.js'
import {
  claimQueued, finishPreflight, insertQueued, selectLatestFor, selectNotice, selectRun,
  selectStaleRunning, type CheckRecord, type NoticeRow, type PreflightRow,
} from '../db/preflightDb.js'
import {
  discoveryConfigured, provenanceCheck, runDiscoveryCheck, runProbeChecks, runScanCheck,
  secretsCheck, substanceCheck, type CheckContext,
} from './preflightChecks.js'
import { notifyTeam } from './preflightNotify.js'
import { verdictFor } from './preflightVerdict.js'

const log = createLogger('preflight', 'orchestrator')

/** Runs this process is executing right now. Bounds the claim, not only the work. */
let inFlight = 0

/** Whether an enqueue may start a drain on its own. Set by the job install; off in tests. */
let autoDrain = false

export interface EnqueueInput {
  submissionId: number
  triggeredBy: string
  /** Redo work the services would otherwise reuse (an existing scan or probe). */
  force?: boolean
}

export interface EnqueueOutcome {
  run: PreflightRow
  /** True when a run was already queued or running and this trigger joined it. */
  joined: boolean
}

export async function enqueuePreflight(input: EnqueueInput): Promise<EnqueueOutcome> {
  if (!(await isEnabled('feature.preflight.enabled'))) {
    throw new AppError('PRECONDITION_FAILED',
      'Pre-flight checks are switched off (feature.preflight.enabled), so nothing can be queued.')
  }
  const subject = await queryOne<{ team_id: number; validation_status: string }>(
    'SELECT team_id, validation_status FROM v_submissions_submission WHERE submission_id = $1',
    [input.submissionId])
  if (!subject) throw new AppError('NOT_FOUND', `Submission ${input.submissionId} was not found.`)
  if (subject.validation_status !== 'VALID') {
    throw new AppError('PRECONDITION_FAILED',
      `Submission ${input.submissionId} is ${subject.validation_status}; only an entry that passed `
      + 'tier 1 can be pre-flighted. Fix the entry first — the checks would only repeat its reason.')
  }

  const outcome = await insertQueued({
    submissionId: input.submissionId, teamId: Number(subject.team_id),
    triggeredBy: input.triggeredBy, forced: input.force === true,
  })
  if (!outcome.joined) {
    await recordAudit({
      actor: input.triggeredBy, action: 'preflight.queued', subjectType: 'submission',
      subjectId: String(input.submissionId),
      payload: { preflightId: outcome.run.preflightId, forced: input.force === true },
    })
    // Off the request's stack (acceptance 5): the caller has its answer before any work begins.
    if (autoDrain) setImmediate(() => { void drainPreflight() })
  }
  return outcome
}

/**
 * Claim and run what is queued, up to the configured concurrency less what is already running.
 * Safe to call from a timer and from an enqueue at once: the claim is the arbiter.
 */
export async function drainPreflight(): Promise<{ claimed: number }> {
  if (!(await isEnabled('feature.preflight.enabled'))) return { claimed: 0 }
  const limit = await getNumber('preflight.concurrency')
  const runs = await claimQueued(Math.max(0, Math.floor(limit) - inFlight))
  if (runs.length === 0) return { claimed: 0 }

  inFlight += runs.length
  try {
    await mapWithLimit(runs, limit, async (run) => {
      try {
        await executeRun(run)
      } finally {
        inFlight--
      }
    })
  } catch (err) {
    // mapWithLimit settles rather than throws; this is belt and braces for the counter.
    log.error('drain failed outside a run', { err })
  }
  return { claimed: runs.length }
}

/** One claimed run, start to finish. Never throws: every outcome is written down. */
async function executeRun(claimed: PreflightRow): Promise<void> {
  const actor = claimed.triggeredBy
  const pin = await captureRunPin()
  const ledger = await openRun({
    kind: 'PREFLIGHT', startedBy: actor,
    params: { submissionId: claimed.submissionId, preflightId: claimed.preflightId, forced: claimed.forced },
    pinnedConfig: { ...pin },
  })
  const ctx: CheckContext = {
    submissionId: claimed.submissionId, runId: ledger.runId, actor, force: claimed.forced,
  }

  let finished: PreflightRow
  try {
    const { checks, skipped, commitSha } = await withRunPin(pin as RunPin, () => runChecks(ctx))
    const verdict = verdictFor(checks)
    finished = await finishPreflight({
      preflightId: claimed.preflightId, status: 'COMPLETED', verdict, checks, skipped,
      commitSha, ledgerRunId: ledger.runId, error: null,
    })
    await closeRun(ledger.runId, 'SUCCEEDED')
    log.info('pre-flight completed', {
      preflightId: claimed.preflightId, submissionId: claimed.submissionId, verdict,
      failing: checks.filter((c) => c.status !== 'PASS').map((c) => `${c.key}:${c.status}`),
    })
  } catch (err) {
    // Only a failure of the orchestration itself reaches here — every check catches its own.
    const error = errorMessage(err)
    finished = await finishPreflight({
      preflightId: claimed.preflightId, status: 'FAILED', verdict: null, checks: [], skipped: [],
      commitSha: null, ledgerRunId: ledger.runId, error,
    })
    await closeRun(ledger.runId, 'FAILED', error)
    log.error('pre-flight run failed', { preflightId: claimed.preflightId, err })
  }

  await recordAudit({
    actor: 'system', action: 'preflight.completed', subjectType: 'submission',
    subjectId: String(claimed.submissionId),
    payload: {
      preflightId: claimed.preflightId, status: finished.status, verdict: finished.verdict,
      commitSha: finished.commitSha, skipped: finished.skipped,
      checks: finished.checks.map((c) => ({ key: c.key, status: c.status })),
    },
  })

  // Told either way (E46-S03), and a failure to tell is itself recorded, never thrown.
  try {
    await notifyTeam(finished)
  } catch (err) {
    log.error('pre-flight notice could not be recorded', { preflightId: claimed.preflightId, err })
  }
}

/** The checks, in order, each as a ledger stage so its duration and outcome are on record. */
async function runChecks(ctx: CheckContext): Promise<{
  checks: CheckRecord[]; skipped: string[]; commitSha: string | null
}> {
  const checks: CheckRecord[] = []
  const skipped: string[] = []
  // Each check is a ledger stage. The hint rides in a wrapper rather than on the record itself,
  // so `__stage` never ends up inside the checks JSON a team's email is composed from.
  const record = async <T>(
    key: string, fn: () => Promise<T>, pick: (t: T) => CheckRecord,
  ): Promise<T> => {
    const wrapped = await stage(
      { runId: ctx.runId, stage: `preflight.${key}`, subjectType: 'submission', subjectId: String(ctx.submissionId) },
      async () => {
        const value = await fn()
        const rec = pick(value)
        // PASS is ok; FAIL is a warning about the subject, not a failed stage; UNKNOWN is skipped.
        const outcome = rec.status === 'PASS' ? 'ok' : rec.status === 'FAIL' ? 'warning' : 'skipped'
        return { value, ...stageOutcome(outcome, rec.summary) }
      },
    )
    return wrapped.value
  }
  const self = (c: CheckRecord) => c

  const scan = await record('scan', () => runScanCheck(ctx), (r) => r.record)
  checks.push(scan.record)
  checks.push(await record('provenance', async () => provenanceCheck(scan.result), self))
  checks.push(await record('substance', () => substanceCheck(scan.result), self))

  const [build, run] = await runProbeChecks(ctx)
  await record('build', async () => build, self)
  await record('run', async () => run, self)
  checks.push(build, run)

  if (await discoveryConfigured()) {
    checks.push(await record('discovery', () => runDiscoveryCheck(ctx, scan.scanId), self))
  } else {
    skipped.push('discovery')
  }

  checks.push(await record('secrets', async () => secretsCheck(scan.result), self))
  return { checks, skipped, commitSha: scan.commitSha }
}

/**
 * A run still RUNNING past the timeout was claimed by a process that went away (E46-S02
 * acceptance 5). Recorded FAILED, and the team told it could not be checked — the alternative
 * is a submission that says "checking" until the event is over.
 */
export async function failStaleRuns(): Promise<{ failed: number }> {
  const timeout = await getNumber('preflight.run_timeout_minutes')
  const stale = await selectStaleRunning(timeout)
  for (const run of stale) {
    const finished = await finishPreflight({
      preflightId: run.preflightId, status: 'FAILED', verdict: null, checks: [], skipped: [],
      commitSha: null, ledgerRunId: run.ledgerRunId,
      error: `The process running these checks stopped before finishing (no result after ${timeout} minutes).`,
    })
    log.error('pre-flight run abandoned', { preflightId: run.preflightId, submissionId: run.submissionId })
    try {
      await notifyTeam(finished)
    } catch (err) {
      log.error('pre-flight notice could not be recorded', { preflightId: run.preflightId, err })
    }
  }
  return { failed: stale.length }
}

export interface PreflightView {
  run: PreflightRow
  notice: NoticeRow | null
}

export async function latestPreflight(submissionId: number): Promise<PreflightView | null> {
  const run = await selectLatestFor(submissionId)
  if (!run) return null
  return { run, notice: await selectNotice(run.preflightId) }
}

export async function getPreflight(preflightId: number): Promise<PreflightView> {
  const run = await selectRun(preflightId)
  if (!run) throw new AppError('NOT_FOUND', `Pre-flight run ${preflightId} was not found.`)
  return { run, notice: await selectNotice(run.preflightId) }
}

/** Wire the port submissions enqueues through (ADR 0002). */
export function installPreflightPort(): void {
  registerPreflightPort({
    async enqueue(input) {
      if (!(await isEnabled('feature.preflight.auto_run'))) return
      await enqueuePreflight(input)
    },
  })
}

/** Let an enqueue start a drain on its own. Only the job install turns this on. */
export function setAutoDrain(on: boolean): void {
  autoDrain = on
}

/** Test seam. */
export function resetPreflightState(): void {
  inFlight = 0
  autoDrain = false
}
