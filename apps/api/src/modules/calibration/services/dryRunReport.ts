/**
 * The full-scale dry run (E11-S04).
 *
 * Distinct from calibration, and the plan says so explicitly: calibration tests whether the
 * SCORES are right; the dry run tests whether the MACHINE survives fifty real inputs. So this
 * reads a completed cohort run and reports what actually happened — wall clock, spend, failures
 * and their causes — then turns those measurements into recommended defaults (acceptance 3).
 *
 * The recommendations are suggestions with their reasoning attached, never applied
 * automatically. A concurrency limit changed by a report nobody read is how a rehearsal makes
 * the real run worse.
 */
import { AppError } from '../../../lib/appError.js'
import { getNumber, getString } from '../../platform/services/configService.js'
import { getRun } from '../../platform/services/runLedgerService.js'
import { runFailures, stageCounts, stageDurations } from '../../batch/db/batchDb.js'
import { selectSubjectCosts } from '../../llm/db/llmCallLogDb.js'
import { median } from './../../batch/services/batchEstimate.js'

export interface StageMeasurement {
  stage: string
  attempted: number
  succeeded: number
  failed: number
  medianMs: number | null
  slowestMs: number | null
}

export interface Recommendation {
  setting: string
  current: number
  suggested: number
  reason: string
}

export interface DryRunReport {
  runId: number
  status: string
  startedAt: Date
  finishedAt: Date | null
  /** Null while the run is still going: an unfinished run has no wall clock. */
  wallClockMs: number | null
  submissions: number
  totalCostUsd: number
  costPerSubmissionUsd: number | null
  stages: StageMeasurement[]
  failures: Array<{ stage: string; subjectId: string | null; cause: string }>
  /** Failure causes grouped, commonest first — the shape of what went wrong. */
  failureCauses: Array<{ cause: string; count: number }>
  recommendations: Recommendation[]
  /** Warnings about the rehearsal itself, rather than about the system it rehearsed. */
  caveats: string[]
  /** Whether it ran early enough to act on (E11-S04 acceptance 4). Null when unknowable. */
  leadTime: {
    evaluationDate: string | null
    days: number | null
    requiredDays: number
    sufficient: boolean | null
    note: string
  }
}

export async function dryRunReport(runId: number): Promise<DryRunReport> {
  const run = await getRun(runId)
  if (!run) throw new AppError('NOT_FOUND', `Run ${runId} was not found.`)
  if (run.kind !== 'COHORT') {
    throw new AppError(
      'VALIDATION_FAILED',
      `Run ${runId} is a ${run.kind} run. A dry-run report describes a full cohort pass ` +
        `through scan, probe and score.`,
    )
  }

  const [counts, failures, costs] = await Promise.all([
    stageCounts(runId),
    runFailures(runId),
    selectSubjectCosts(runId),
  ])

  const stages: StageMeasurement[] = []
  for (const row of counts) {
    const durations = await stageDurations(runId, row.stage)
    stages.push({
      stage: row.stage,
      attempted: row.ok + row.warning + row.failed + row.skipped,
      succeeded: row.ok + row.warning,
      failed: row.failed,
      medianMs: median(durations),
      slowestMs: durations.length === 0 ? null : Math.max(...durations),
    })
  }

  const submissions = costs.length
  const totalCostUsd = Number(run.costUsd)

  return {
    runId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    wallClockMs: run.finishedAt === null
      ? null
      : run.finishedAt.getTime() - run.startedAt.getTime(),
    submissions,
    totalCostUsd,
    costPerSubmissionUsd: submissions === 0
      ? null
      : Math.round((totalCostUsd / submissions) * 1e6) / 1e6,
    stages,
    failures: failures.map((f) => ({
      stage: f.stage, subjectId: f.subject_id, cause: f.message,
    })),
    failureCauses: groupCauses(failures.map((f) => f.message)),
    recommendations: await recommend(stages),
    caveats: caveatsFor(run.status, submissions, stages),
    leadTime: await leadTime(run.startedAt),
  }
}

/**
 * How far ahead of the real evaluation this rehearsal ran (E11-S04 acceptance 4).
 *
 * Returns "unknown" rather than "fine" when no evaluation date is configured. The requirement
 * exists because a rehearsal the day before leaves no time to fix what it found, and answering
 * an unknown with reassurance would defeat it.
 */
async function leadTime(startedAt: Date): Promise<DryRunReport['leadTime']> {
  const requiredDays = await getNumber('event.dry_run_lead_days')
  const configured = (await getString('event.evaluation_date')).trim()

  if (configured === '') {
    return {
      evaluationDate: null, days: null, requiredDays, sufficient: null,
      note:
        'No evaluation date is configured, so whether this rehearsal ran early enough cannot ' +
        'be checked. Set event.evaluation_date.',
    }
  }

  const evaluation = new Date(configured)
  if (Number.isNaN(evaluation.getTime())) {
    return {
      evaluationDate: configured, days: null, requiredDays, sufficient: null,
      note: `The configured evaluation date '${configured}' is not a date the system can read.`,
    }
  }

  const days = Math.floor(
    (evaluation.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000))
  const sufficient = days >= requiredDays

  return {
    evaluationDate: configured,
    days,
    requiredDays,
    sufficient,
    note: sufficient
      ? `This rehearsal ran ${days} days before the evaluation, meeting the ${requiredDays} ` +
        `day minimum.`
      : days < 0
        ? `This rehearsal ran ${Math.abs(days)} days AFTER the evaluation date, so it cannot ` +
          `have informed it.`
        : `This rehearsal ran only ${days} day(s) before the evaluation, short of the ` +
          `${requiredDays} required. Anything it found may not be fixable and re-rehearsed in ` +
          `time to matter.`,
  }
}

/**
 * Failure causes grouped by their opening words.
 *
 * Messages carry specifics — a repository URL, a submission id — so grouping on the whole string
 * would report fifty distinct causes for one problem. The first few words are what identifies
 * the KIND of failure, which is what a rehearsal is trying to discover.
 */
export function groupCauses(messages: readonly string[]): Array<{ cause: string; count: number }> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const key = message.split(/[:.]/)[0]!.trim().slice(0, 120) || 'Unspecified'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Suggested defaults, from what the rehearsal measured (acceptance 3).
 *
 * Only where the evidence supports a change. A report that always recommends something trains
 * its reader to ignore it, and the most useful outcome of a dry run is often "these settings
 * were fine".
 */
async function recommend(stages: readonly StageMeasurement[]): Promise<Recommendation[]> {
  const out: Recommendation[] = []

  const probe = stages.find((s) => s.stage === 'probe')
  const probeLimit = await getNumber('batch.probe_concurrency')
  if (probe?.medianMs !== null && probe !== undefined && probe.medianMs! > 240_000) {
    out.push({
      setting: 'batch.probe_concurrency',
      current: probeLimit,
      suggested: Math.max(1, probeLimit - 1),
      reason:
        `The median probe took ${Math.round(probe.medianMs! / 1000)}s. Builds that slow are ` +
        `usually contending for the same disk and CPU, and running fewer at once often ` +
        `finishes the stage sooner rather than later.`,
    })
  }

  const scan = stages.find((s) => s.stage === 'scan')
  const scanLimit = await getNumber('batch.scan_concurrency')
  if (scan?.medianMs !== null && scan !== undefined && scan.medianMs! < 5_000 && scan.failed === 0) {
    out.push({
      setting: 'batch.scan_concurrency',
      current: scanLimit,
      suggested: scanLimit + 2,
      reason:
        `Scanning took a median of ${Math.round(scan.medianMs! / 1000)}s with no failures, so ` +
        `the stage is not the bottleneck and can safely take more in parallel.`,
    })
  }

  // A stage that failed for more than one submission in ten is a depth problem, not a
  // concurrency one — the profile is asking for more than these repositories can give.
  for (const stage of stages) {
    if (stage.attempted >= 10 && stage.failed / stage.attempted > 0.1) {
      out.push({
        setting: `scans.default_depth (${stage.stage} failures)`,
        current: 0,
        suggested: 0,
        reason:
          `${stage.failed} of ${stage.attempted} submissions failed at the ${stage.stage} ` +
          `stage. Above one in ten, the cause is usually the depth profile or the timeout ` +
          `rather than parallelism — read the causes below before changing a concurrency limit.`,
      })
    }
  }

  return out
}

/** What would make this rehearsal a poor guide to the real run. */
function caveatsFor(
  status: string, submissions: number, stages: readonly StageMeasurement[],
): string[] {
  const caveats: string[] = []

  if (status !== 'SUCCEEDED') {
    caveats.push(
      `This run ended ${status}, so its measurements describe a partial pass. The wall clock in ` +
      `particular is not a prediction of a complete run.`)
  }
  if (submissions < 50) {
    caveats.push(
      `${submissions} submissions were measured; E11-S04 asks for fifty. Contention appears at ` +
      `scale, so a smaller rehearsal tends to make the system look faster than it will be.`)
  }
  if (stages.some((s) => s.medianMs === null)) {
    caveats.push(
      'At least one stage produced no timing at all, so the recommendations below rest on an ' +
      'incomplete picture.')
  }

  return caveats
}
