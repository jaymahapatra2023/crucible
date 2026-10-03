/**
 * Running a whole cohort through scan → probe → score (E10).
 *
 * This is an orchestrator (P2): it sequences work that other modules do, and contains no scoring,
 * scanning or probing logic of its own. What it owns is the policy that makes an unattended
 * overnight run safe.
 *
 * Four decisions shape the rest of the file:
 *
 *  - **Stage by stage, not submission by submission.** All fifty are scanned, then all fifty
 *    probed, then all fifty scored. It costs a little wall-clock, and it buys the thing that
 *    matters: each stage has its own concurrency limit because each is bound by something
 *    different (disk, containers, a provider), and interleaving would make those limits
 *    meaningless (E10-S02 acceptance 1).
 *  - **A failure is data, not an exception.** Every per-submission failure is recorded against
 *    the ledger and the run carries on; the summary lists them all (E10-S04).
 *  - **The run pauses rather than failing when it runs out of budget.** The work already done is
 *    worth keeping, and an operator who raises the ceiling should resume, not restart (E10-S03).
 *  - **Progress is written down, not only published.** A websocket message is gone on reload,
 *    which is exactly when somebody checks on an overnight run (E10-S05).
 */
import { mapWithLimit } from '../../../lib/pool.js'
import { withRunPin, type RunPin } from '../../../lib/runScope.js'
import { finishRun, type FinishOutcome } from './batchFinish.js'
import { createLogger } from '../../../lib/logger.js'
import { AppError, errorMessage } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { publish, runTopic } from '../../../http/progressHub.js'
import { captureRunPin, getNumber, isEnabled } from '../../platform/services/configService.js'
import {
  closeRun, completedSubjects, getRun, openRun, pauseRun, stage,
} from '../../platform/services/runLedgerService.js'
import { scanSubmission } from '../../scans/services/scanService.js'
import { probeSubmission } from '../../probes/services/probeService.js'
import { discoverSubmission } from '../../discovery/services/discoveryService.js'
import { scoreSubmission } from '../../scoring/services/submissionScorer.js'
import { frozenRubric } from '../../rubrics/services/rubricService.js'
import { insertScoreRun, selectScoreRunFor } from '../../scoring/db/scoringDb.js'
import { recordCohorts } from '../../scoring/db/rankingDb.js'
import {
  eligibleSubjects, historicalDurations, namedSubjects, runFailures, stageCounts, stageDurations,
  upsertProgress, type BatchSubject,
} from '../db/batchDb.js'
import {
  ceilingVerdict, estimatedFinish, projectedCost, type EstimateInput,
} from './batchEstimate.js'

const log = createLogger('batch', 'orchestrator')

/**
 * Stage order, and it is the order that matters.
 *
 * `discovery` sits BEFORE `score` because scoring reads what it produces: the principles and
 * standards evaluators are given a digest of the findings. Running it after would leave every
 * submission scored without the context discovery exists to supply.
 */
export const STAGES = ['scan', 'probe', 'discovery', 'score'] as const
export type Stage = (typeof STAGES)[number]

export interface BatchInput {
  challengeIds: readonly number[]
  cohortKey: string
  /**
   * Score exactly these submissions, instead of every valid entry in the challenges.
   *
   * Calibration uses it: golden-set repositories are excluded from ordinary runs (migration 091)
   * precisely so they cannot join a real cohort, so the run that *does* score them has to name
   * them. Still filtered to what validated, so a named submission that is not scorable is
   * reported rather than silently carried.
   */
  submissionIds?: readonly number[]
  runIndex: 1 | 2
  startedBy: string
  /** Skip work already completed in this run rather than redoing it (E10-S04 acceptance 2). */
  resumeRunId?: number
  /** Redo completed work. Deliberately separate from resume so it cannot happen by accident. */
  force?: boolean
  /**
   * Describe each submission before scoring it (E15-S02).
   *
   * Opt-in per batch, preserving the cost decision the feature flag exists to make. When it is
   * off, EVERY submission is undiscovered — which is consistent, and therefore fair. The unfair
   * case is a cohort where some were and some were not, which is what E15-S04 reports.
   */
  withDiscovery?: boolean
  /**
   * Called once the run is open, before any work begins.
   *
   * A cohort run takes hours; the caller needs its id in milliseconds so progress can be watched
   * from the first second. Passing the ids back through a callback avoids either holding an HTTP
   * request open for the duration or polling for a row that may not exist yet.
   */
  onStarted?: (ids: {
    runId: number
    scoreRunId: number
    subjects: number
    /** From durations measured in earlier runs; null when nothing comparable has run. */
    estimatedFinishAt: Date | null
  }) => void
}

export interface BatchSummary {
  runId: number
  scoreRunId: number
  status: string
  subjects: number
  perStage: Record<Stage, { ok: number; failed: number; skipped: number }>
  failures: Array<{ stage: string; subjectId: string | null; message: string }>
  costUsd: number
  pausedReason: string | null
  /**
   * What happened after the last submission was scored (E24).
   *
   * Null when the run paused or failed before reaching it — the ranking is not something that
   * half-happens.
   */
  finish: FinishOutcome | null
}

export async function runBatch(input: BatchInput): Promise<BatchSummary> {
  const subjects = input.submissionIds === undefined
    ? await eligibleSubjects(input.challengeIds)
    : await namedSubjects(input.submissionIds)
  if (subjects.length === 0) {
    // A typed refusal, not a bare throw: an operator starting an overnight run against the
    // wrong challenge id should be told so at once, not handed a 500.
    throw new AppError(
      'PRECONDITION_FAILED',
      input.submissionIds === undefined
        ? `No valid submissions match challenge(s) ` +
          `${input.challengeIds.length === 0 ? '(all)' : input.challengeIds.join(', ')}. An empty ` +
          `run would complete successfully and evaluate nobody.`
        : `None of the ${input.submissionIds.length} named submission(s) validated, so there is ` +
          `nothing to score. An empty run would complete successfully and evaluate nobody.`,
    )
  }

  // Checked once, up front. Without this a batch asking for discovery while the feature is off
  // would fail the stage separately for every submission — fifty identical failures saying the
  // same thing, and a run that looks like fifty broken repositories rather than one setting.
  if (input.withDiscovery === true && !(await isEnabled('feature.discovery.enabled'))) {
    throw new AppError(
      'PRECONDITION_FAILED',
      'This batch asked for discovery, but repository discovery is disabled. Enable ' +
        "'feature.discovery.enabled' before starting the run, or start it without discovery — " +
        'a cohort where only some submissions were described is worse than one where none were.',
    )
  }

  const limits = await concurrencyLimits()
  const run = await openBatchRun(input, subjects, limits)
  const scoreRunId = await openScoreRun(input, subjects)
  // Reported at run start (E10-S02 acceptance 3), from earlier runs' measured durations. Null
  // on the very first run of a new deployment, which is the honest answer at that point.
  input.onStarted?.({
    runId: run.runId,
    scoreRunId,
    subjects: subjects.length,
    estimatedFinishAt: await openingEstimate(subjects.length, limits),
  })

  const summary: BatchSummary = {
    runId: run.runId,
    scoreRunId,
    status: 'RUNNING',
    subjects: subjects.length,
    perStage: {
      scan: { ok: 0, failed: 0, skipped: 0 },
      probe: { ok: 0, failed: 0, skipped: 0 },
      discovery: { ok: 0, failed: 0, skipped: 0 },
      score: { ok: 0, failed: 0, skipped: 0 },
    },
    failures: [],
    costUsd: 0,
    pausedReason: null,
    finish: null,
  }

  try {
    for (const stageName of STAGES) {
      // Opt-in, and off by default. Seven model calls per submission is a cost that should be
      // chosen; a stage that ran because nobody said otherwise would make spend unpredictable
      // across a cohort.
      if (stageName === 'discovery' && input.withDiscovery !== true) {
        summary.perStage.discovery.skipped = subjects.length
        continue
      }
      // Every stage runs inside the pin taken when the run opened (E14-S02). This is what makes
      // P4.4 true rather than merely recorded: a setting changed while the batch is in flight
      // no longer reshapes the submissions it has not reached yet.
      const paused = await withRunPin(run.pinnedConfig as unknown as RunPin, () =>
        runStage({ input, run: run.runId, scoreRunId, stageName, subjects, limits, summary }))
      if (paused) {
        summary.status = 'PAUSED'
        summary.pausedReason = paused
        await pauseRun(run.runId, paused)
        await pauseAudit(run.runId, input.startedBy, paused, summary)
        return await withFailures(summary)
      }
    }

    // Rank, compare and open the shortlist — inside the same pin, because the cut line and the
    // normalisation floor decide an outcome just as the scoring settings do (E14-S02).
    const finish = await withRunPin(run.pinnedConfig as unknown as RunPin, () =>
      finishRun({ scoreRunId, cohortKey: input.cohortKey, actor: input.startedBy }))
    summary.finish = finish

    if (finish.pausedReason) {
      summary.status = 'PAUSED'
      summary.pausedReason = finish.pausedReason
      await pauseRun(run.runId, finish.pausedReason)
      await pauseAudit(run.runId, input.startedBy, finish.pausedReason, summary)
      return await withFailures(summary)
    }

    // A run where some submissions failed still SUCCEEDED: the scores it produced are real and
    // the failures are recorded per submission. Failing the whole run would throw away work and
    // tell an operator less, not more.
    await closeRun(run.runId, 'SUCCEEDED')
    summary.status = 'SUCCEEDED'
  } catch (err) {
    // Only a failure of the orchestration itself reaches here; per-submission failures are
    // caught inside the stage.
    await closeRun(run.runId, 'FAILED', errorMessage(err))
    summary.status = 'FAILED'
    log.error('batch run failed', { runId: run.runId, err })
  }

  return withFailures(summary)
}

interface StageContext {
  input: BatchInput
  run: number
  scoreRunId: number
  stageName: Stage
  subjects: readonly BatchSubject[]
  limits: Record<Stage, number>
  summary: BatchSummary
}

/** Run one stage across every subject. Returns a pause reason, or null to continue. */
async function runStage(ctx: StageContext): Promise<string | null> {
  const { stageName, subjects, summary } = ctx

  const alreadyDone = ctx.input.force === true
    ? new Set<string>()
    : await completedSubjects(ctx.run, stageName)

  const pending = subjects.filter((s) => !alreadyDone.has(String(s.submission_id)))
  summary.perStage[stageName].skipped = subjects.length - pending.length

  await publishProgress(ctx, null, subjects.length - pending.length)

  if (pending.length === 0) {
    log.info('stage already complete; skipping', { runId: ctx.run, stage: stageName })
    return null
  }

  // Checked BEFORE the stage, not only during it: a stage that would obviously exceed the
  // ceiling should not start.
  const before = await checkCeiling(ctx, summary.perStage[stageName].skipped, subjects.length)
  if (before) return before

  let completed = summary.perStage[stageName].skipped
  let pauseReason: string | null = null

  const results = await mapWithLimit(pending, ctx.limits[stageName], async (subject) => {
    if (pauseReason !== null) {
      // Already over budget: the tasks still in flight finish, but nothing new starts.
      summary.perStage[stageName].skipped++
      return
    }

    await publishProgress(ctx, subject, completed)

    try {
      await stage(
        { runId: ctx.run, stage: stageName, subjectType: 'submission', subjectId: String(subject.submission_id) },
        () => runOne(ctx, subject),
      )
      summary.perStage[stageName].ok++
    } catch (err) {
      // Recorded by `stage` against the ledger; counted here so the summary can report it.
      summary.perStage[stageName].failed++
      log.warn('submission failed a stage', {
        runId: ctx.run, stage: stageName, submissionId: subject.submission_id,
        err: errorMessage(err),
      })
    }

    completed++
    pauseReason ??= await checkCeiling(ctx, completed, subjects.length)
  })

  // The final position, with no current item. Without this the last write is the one made
  // BEFORE the last submission, so a finished stage reads as one short of complete.
  await publishProgress(ctx, null, completed)

  log.info('stage complete', {
    runId: ctx.run, stage: stageName, ...summary.perStage[stageName],
    settled: results.length,
  })

  return pauseReason
}

async function runOne(ctx: StageContext, subject: BatchSubject): Promise<unknown> {
  const common = { submissionId: subject.submission_id, runId: ctx.run, actor: ctx.input.startedBy }

  switch (ctx.stageName) {
    case 'scan':
      return scanSubmission(common)
    case 'probe':
      return probeSubmission(common)
    case 'discovery':
      // Records against the batch's run rather than opening its own, so a cohort's discovery
      // spend counts against the batch ceiling like every other stage.
      return discoverSubmission({
        submissionId: subject.submission_id,
        actor: ctx.input.startedBy,
        runId: ctx.run,
      })
    case 'score': {
      const rubric = await frozenRubric(subject.challenge_id)
      if (!rubric) {
        // Recorded as this submission's stage failure and named in the run summary, so the
        // operator learns which challenge is unfrozen rather than that "scoring failed".
        throw new AppError(
          'PRECONDITION_FAILED',
          `Challenge ${subject.challenge_id} has no frozen rubric, so this submission cannot be ` +
            `scored. Freeze it and resume the run.`)
      }
      return scoreSubmission({
        runIndexId: ctx.scoreRunId,
        submissionId: subject.submission_id,
        rubric,
        ledgerRunId: ctx.run,
        resume: ctx.input.force !== true,
      })
    }
  }
}

/** Whether spend or its projection has crossed the ceiling (E10-S03). */
async function checkCeiling(
  ctx: StageContext, completed: number, total: number,
): Promise<string | null> {
  const [ceiling, minimumSamples] = await Promise.all([
    getNumber('batch.cost_ceiling_usd'),
    getNumber('batch.projection_after'),
  ])

  const run = await getRun(ctx.run)
  const costSoFarUsd = Number(run?.costUsd ?? 0)
  const projectedUsd = projectedCost({ costSoFarUsd, completed, total, minimumSamples })

  const verdict = ceilingVerdict({ costSoFarUsd, projectedUsd, ceilingUsd: ceiling })
  if (verdict.action === 'CONTINUE') return null

  log.warn('cost ceiling reached; pausing run', {
    runId: ctx.run, costSoFarUsd, projectedUsd, ceiling,
  })
  return verdict.reason
}

/** Write and publish where the run is now (E10-S05). */
async function publishProgress(
  ctx: StageContext, current: BatchSubject | null, completed: number,
): Promise<void> {
  const total = ctx.subjects.length
  const run = await getRun(ctx.run)
  const costSoFarUsd = Number(run?.costUsd ?? 0)
  const minimumSamples = await getNumber('batch.projection_after')

  const projected = projectedCost({ costSoFarUsd, completed, total, minimumSamples })
  const finish = await estimateFinish(ctx, completed)

  await upsertProgress({
    runId: ctx.run,
    stage: ctx.stageName,
    currentSubject: current ? String(current.submission_id) : null,
    currentLabel: current?.team_name ?? null,
    completed,
    total,
    estimatedFinishAt: finish,
    projectedCostUsd: projected,
  })

  publish(runTopic(ctx.run), 'progress', {
    stage: ctx.stageName,
    currentSubject: current?.submission_id ?? null,
    currentLabel: current?.team_name ?? null,
    completed,
    total,
    estimatedFinishAt: finish?.toISOString() ?? null,
    projectedCostUsd: projected,
    costUsd: costSoFarUsd,
  })
}

/**
 * When the run should finish, from measured durations.
 *
 * Samples from this run first, falling back to earlier runs so the FIRST run of an evening can
 * still be estimated — an estimate that only appears once a run is well under way arrives after
 * the operator has already decided to start it. Returns null when a stage has no measurement at
 * all, rather than inventing one.
 */
async function estimateFinish(ctx: StageContext, completed: number): Promise<Date | null> {
  const stagesRemaining: EstimateInput[] = []
  const currentIndex = STAGES.indexOf(ctx.stageName)

  for (let i = currentIndex; i < STAGES.length; i++) {
    const name = STAGES[i]!
    const samples = await stageDurations(ctx.run, name)
    const usable = samples.length > 0 ? samples : await historicalDurations(name)
    stagesRemaining.push({
      samples: usable,
      remaining: i === currentIndex ? ctx.subjects.length - completed : ctx.subjects.length,
      concurrency: ctx.limits[name],
    })
  }

  return estimatedFinish(new Date(), stagesRemaining)
}

/** The finish time to quote before any work has been done, from earlier runs. */
async function openingEstimate(
  subjects: number, limits: Record<Stage, number>,
): Promise<Date | null> {
  const stages: EstimateInput[] = []
  for (const name of STAGES) {
    stages.push({
      samples: await historicalDurations(name),
      remaining: subjects,
      concurrency: limits[name],
    })
  }
  return estimatedFinish(new Date(), stages)
}

async function concurrencyLimits(): Promise<Record<Stage, number>> {
  const [scan, probe, discovery, score] = await Promise.all([
    getNumber('batch.scan_concurrency'),
    getNumber('batch.probe_concurrency'),
    // Provider-bound rather than disk- or container-bound, and each submission makes seven
    // sequential calls — so it gets its own limit rather than borrowing the scan one.
    getNumber('batch.discovery_concurrency'),
    getNumber('batch.score_concurrency'),
  ])
  return { scan, probe, discovery, score }
}

async function openBatchRun(
  input: BatchInput, subjects: readonly BatchSubject[], limits: Record<Stage, number>,
) {
  return openRun({
    kind: 'COHORT',
    startedBy: input.startedBy,
    params: {
      challengeIds: [...input.challengeIds],
      cohortKey: input.cohortKey,
      runIndex: input.runIndex,
      // The order is RECORDED, not merely deterministic (E10-S01 acceptance 3): a resumed or
      // repeated run can be compared against this one only if both agree what the order was.
      order: subjects.map((s) => s.submission_id),
      resumedFrom: input.resumeRunId ?? null,
      forced: input.force === true,
    },
    // P4.4. Derived from the declaration rather than a hand-listed set of keys: this used to
    // pin four of them, none of which decided an outcome, and no feature flags at all. The
    // concurrency limits are recorded alongside for the operator's benefit — they are
    // operational and deliberately NOT pinned, so raising one during a run still takes effect.
    pinnedConfig: { ...(await captureRunPin()), limits },
  })
}

/**
 * The score run this batch writes into, and the cohort sizes it will normalise against.
 *
 * REUSES an existing run for the same (cohort, index) rather than inserting a second one. A
 * resumed batch must write its remaining scores into the run that already holds the rest —
 * inserting a new one would collide with the uniqueness constraint, and if it did not, it would
 * split one cohort's scores across two runs that neither ranks nor variance could reconcile.
 */
async function openScoreRun(
  input: BatchInput, subjects: readonly BatchSubject[],
): Promise<number> {
  const existing = await selectScoreRunFor(input.cohortKey, input.runIndex)
  if (existing) {
    log.info('reusing the existing score run for this cohort', {
      cohortKey: input.cohortKey, runIndex: input.runIndex,
      runIndexId: existing.run_index_id,
    })
    return existing.run_index_id
  }

  const versions: Record<string, number> = {}
  const counts = new Map<number, number>()

  for (const subject of subjects) {
    counts.set(subject.challenge_id, (counts.get(subject.challenge_id) ?? 0) + 1)
    if (versions[String(subject.challenge_id)] === undefined) {
      const rubric = await frozenRubric(subject.challenge_id)
      if (rubric) versions[String(subject.challenge_id)] = rubric.version
    }
  }

  const scoreRun = await insertScoreRun({
    runIndex: input.runIndex,
    cohortKey: input.cohortKey,
    rubricVersions: versions,
    model: 'batch',
    ledgerRunId: null,
    startedBy: input.startedBy,
  })

  const floorUsed = await getNumber('scoring.min_cohort_size')
  await recordCohorts(scoreRun.run_index_id, [...counts].map(([challengeId, cohortSize]) => ({
    challengeId, cohortSize, floorUsed,
  })))

  return scoreRun.run_index_id
}

async function pauseAudit(
  runId: number, actor: string, reason: string, summary: BatchSummary,
): Promise<void> {
  await recordAudit({
    actor,
    action: 'batch.run_paused',
    subjectType: 'run',
    subjectId: String(runId),
    payload: { reason, perStage: summary.perStage, costUsd: summary.costUsd },
  })
}

/** Attach the failure list and final counts (E10-S04 acceptance 4). */
async function withFailures(summary: BatchSummary): Promise<BatchSummary> {
  const [failures, counts, run] = await Promise.all([
    runFailures(summary.runId),
    stageCounts(summary.runId),
    getRun(summary.runId),
  ])

  for (const row of counts) {
    const stageName = row.stage as Stage
    if (summary.perStage[stageName]) {
      summary.perStage[stageName] = {
        ok: row.ok + row.warning, failed: row.failed, skipped: row.skipped,
      }
    }
  }

  summary.costUsd = Number(run?.costUsd ?? 0)
  summary.failures = failures.map((f) => ({
    stage: f.stage, subjectId: f.subject_id, message: f.message,
  }))
  return summary
}
