/**
 * Describing what a submission IS, as distinct from how well it scores (E12).
 *
 * Discovery reads a persisted scan — it never clones, for the same reason scoring never scans
 * implicitly: a step that could fetch code on its own would make the evaluated commit, the cost
 * and the timing unpredictable.
 *
 * Seven concerns, run one at a time, each recording its own outcome. Concurrency is deliberately
 * not used here: seven parallel calls per submission across a cohort of forty would breach the
 * gateway's concurrency budget and make the per-run cost ceiling (E10-S03) fire on batch order
 * rather than on spend.
 *
 * `claims` runs last because it compares documentation against what the other six found, not
 * against a second reading of the source.
 */
import { AppError, errorMessage } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { captureRunPin, getNumber, isEnabled } from '../../platform/services/configService.js'
import {
  closeRun, completedSubjects, openRun, pauseRun, stage,
} from '../../platform/services/runLedgerService.js'
import { withRunPin, type RunPin } from '../../../lib/runScope.js'
import { persistedScanRef } from '../../scans/services/scanService.js'
import { writeAudit } from '../../governance/services/auditService.js'
import {
  currentDiscovery, finishDiscovery, insertConflicts, insertFindings, openDiscovery,
  type DiscoveryRunRow,
} from '../db/discoveryDb.js'
import { CONCERNS, type ConcernKey, type ConcernResult } from './discoveryConcerns.js'
import { runConcern } from './discoveryExtractor.js'
import type { MappedFinding } from './discoveryMappers.js'

const log = createLogger('discovery', 'service')

/** Ledger stage for one concern of one submission. Kept apart from the batch's own record. */
const CONCERN_STAGE = 'discovery.concern'

export interface DiscoverInput {
  submissionId: number
  actor: string
  /**
   * An existing ledger run to record against — the batch's, when discovery runs as a stage.
   *
   * Left out, discovery opens its own. Either way it HAS one, which is what brings its spend
   * under a cost ceiling and its progress into the ledger (E15-S01).
   */
  runId?: number | undefined
  /**
   * Re-describe the submission even if it has already been described at this commit.
   *
   * Off by default, because discovery is seven sequential model calls and the thing it
   * describes is a fixed commit. See the reuse check in `discoverSubmission`.
   */
  force?: boolean | undefined
}

export interface DiscoverOutcome {
  discoveryId: number
  status: 'COMPLETED' | 'FAILED'
  concerns: Record<string, ConcernResult>
  costUsd: number
  /** True when at least one concern produced findings a reviewer can act on. */
  usable: boolean
  /** Why the run stopped short, when it did. Null when every concern was attempted. */
  paused: string | null
  /** True when this returned an earlier description instead of making any model call. */
  reused: boolean
}

export async function discoverSubmission(input: DiscoverInput): Promise<DiscoverOutcome> {
  if (!(await isEnabled('feature.discovery.enabled'))) {
    throw new AppError(
      'PRECONDITION_FAILED',
      'Repository discovery is disabled. It costs roughly seven model calls per submission and ' +
        'describes a submission rather than scoring one, so it is enabled per event.',
    )
  }

  const scan = await persistedScanRef(input.submissionId)

  // Already described, at this very commit? Then return that description rather than buying it
  // again. Scan and probe have always worked this way; discovery did not, and it is by far the
  // most expensive of the three — seven sequential model calls, measured at 12 minutes and
  // sometimes 19 per submission. Pre-flight describes every entry as it arrives, so without
  // this a cohort run of thirty teams spent two hours re-learning what it already knew.
  //
  // Keyed on the COMMIT, not the submission: the same commit is the same code, which is the
  // only thing that makes a description still true. A null sha on either side is not a match —
  // we cannot show they are the same, so we do the work.
  if (input.force !== true) {
    const existing = await currentDiscovery(input.submissionId)
    if (existing !== null && existing.status === 'COMPLETED'
        && existing.commit_sha !== null && existing.commit_sha === scan.commitSha) {
      const concerns = existing.concerns as Record<string, ConcernResult>
      log.info('submission already described at this commit; reusing', {
        submissionId: input.submissionId, discoveryId: Number(existing.discovery_id),
        commitSha: existing.commit_sha,
      })
      return {
        discoveryId: Number(existing.discovery_id),
        status: 'COMPLETED',
        concerns,
        // Nothing was spent NOW. The original run carries what it cost; reporting it twice
        // would make a cohort look twice as expensive as it was.
        costUsd: 0,
        usable: Object.values(concerns).some((c) => c.outcome === 'FOUND'),
        paused: null,
        reused: true,
      }
    }
  }

  // Its own ledger run when nobody supplied one. Seven sequential model calls with no run is
  // seven calls nothing can account for: no progress, no resume, and spend outside every
  // ceiling, because a ceiling is enforced against a run.
  const owned = input.runId === undefined
  const pin = owned ? await captureRunPin() : null
  const ledgerRunId = input.runId ?? (await openRun({
    kind: 'DISCOVERY',
    startedBy: input.actor,
    params: { submissionId: input.submissionId, concerns: CONCERNS.map((c) => c.key) },
    pinnedConfig: { ...(pin as RunPin) },
  })).runId

  const run = await openDiscovery({
    submissionId: input.submissionId,
    scanId: scan.scanId,
    commitSha: scan.commitSha,
    ledgerRunId,
    startedBy: input.actor,
  })

  try {
    // Pinned when this run owns itself (E14-S02). Inside a batch it is already within the
    // batch's pin, and entering a second one would replace the cohort's settings with a fresh
    // capture — exactly the mid-run drift the pin exists to prevent.
    const body = () => execute(run, scan.result, { ...input, runId: ledgerRunId })
    const outcome = pin ? await withRunPin(pin, body) : await body()
    // A paused run stays paused. Closing it SUCCEEDED would erase the one fact an operator
    // needs: that there is work left to resume.
    if (owned && !outcome.paused) await closeRun(ledgerRunId, 'SUCCEEDED')
    return outcome
  } catch (err) {
    if (owned) await closeRun(ledgerRunId, 'FAILED', errorMessage(err))
    // The run row is left FAILED rather than deleted: a discovery that broke is a fact about
    // this submission that an operator needs to see, not an absence to be tidied away.
    await finishDiscovery({
      discoveryId: Number(run.discovery_id), status: 'FAILED', concerns: {},
      model: null, costUsd: 0, error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

async function execute(
  run: DiscoveryRunRow, scan: Awaited<ReturnType<typeof persistedScanRef>>['result'],
  input: DiscoverInput,
): Promise<DiscoverOutcome> {
  const discoveryId = Number(run.discovery_id)
  const concerns: Record<string, ConcernResult> = {}
  const collected: Record<string, MappedFinding[]> = {}
  let costUsd = 0
  let model: string | null = null
  /** Set when the cost ceiling stopped the run part-way. */
  let paused: string | null = null

  // Resolved once for the whole run, so every concern is checked on the same terms.
  const drift = await getNumber('scoring.citation_line_drift')

  const ledgerRunId = input.runId as number
  // Concerns already completed in this run, so a resumed discovery does not pay for them twice.
  //
  // Scoped per submission. Inside a batch the run is shared by the whole cohort, so an
  // unqualified concern key would let submission B skip 'endpoints' because submission A had
  // already done it — every submission after the first would come back nearly empty.
  const done = await completedSubjects(ledgerRunId, CONCERN_STAGE)
  const stageKey = (concern: string) => `${input.submissionId}:${concern}`
  const ceiling = await getNumber('discovery.cost_ceiling_usd')

  for (const concern of CONCERNS) {
    if (done.has(stageKey(concern.key))) {
      log.info('concern already completed in this run, skipping', { concern: concern.key })
      continue
    }

    // Checked before each call rather than after the run: a ceiling that only stops work once
    // it has been done is a report, not a ceiling.
    if (costUsd >= ceiling) {
      paused = `Discovery reached its $${ceiling} ceiling after `
        + `${Object.keys(concerns).length} concern(s). What was extracted is kept; raise the `
        + `ceiling and resume.`
      await pauseRun(ledgerRunId, paused)
      break
    }

    // Recorded per concern, so progress is persisted as well as published — a websocket
    // message is gone on reload, which is when somebody checks on a long run.
    const output = await stage(
      {
        runId: ledgerRunId,
        // A distinct stage name from the batch's own per-submission 'discovery' record, so the
        // two never share a namespace.
        stage: CONCERN_STAGE,
        subjectType: 'concern',
        subjectId: stageKey(concern.key),
      },
      () => runConcern({
        concern, scan, drift,
        submissionId: input.submissionId,
        runId: ledgerRunId,
        ...(concern.key === 'claims' && { codeFindings: summariseFindings(collected) }),
      }))

    concerns[concern.key] = output.result
    costUsd += output.result.costUsd
    model ??= output.result.model

    if (output.findings.length > 0) {
      collected[concern.key] = output.findings
      await insertFindings(discoveryId, input.submissionId, output.findings)
    }
    if (output.conflicts.length > 0) {
      await insertConflicts(discoveryId, input.submissionId, output.conflicts.map((c) => ({
        ...c, discovery_id: discoveryId,
      })))
    }
  }

  // Concerns the run never reached are recorded as such rather than left absent. An absent
  // concern renders as FAILED with no explanation, which reads as "we tried and could not" —
  // and we did not try.
  if (paused) {
    for (const concern of CONCERNS) {
      concerns[concern.key] ??= {
        outcome: 'FAILED', count: 0, costUsd: 0, model: null,
        note: 'Not attempted: the run stopped at its cost ceiling before reaching this concern.',
      }
    }
  }

  const usable = Object.values(concerns).some((c) => c.outcome === 'FOUND')
  await finishDiscovery({
    discoveryId, status: 'COMPLETED', concerns, model, costUsd, error: paused,
  })

  await writeAudit({
    actor: input.actor,
    action: 'discovery.completed',
    subjectType: 'submission',
    subjectId: String(input.submissionId),
    payload: {
      discoveryId,
      outcomes: Object.fromEntries(
        Object.entries(concerns).map(([k, v]) => [k, v.outcome])),
      costUsd,
    },
  })

  log.info('discovery completed', { discoveryId, submissionId: input.submissionId, costUsd, usable })
  return { discoveryId, status: 'COMPLETED', concerns, costUsd, usable, paused, reused: false }
}

/**
 * What the code extractors found, as text the claims extractor can compare documentation to.
 *
 * Capped hard. Passing every finding would push the claims call past its context budget on a
 * large repository, and the tail of a list of eighty endpoints adds nothing to the question
 * "does the README describe this application".
 */
export function summariseFindings(collected: Record<string, MappedFinding[]>): string {
  const sections: string[] = []
  for (const key of Object.keys(collected) as ConcernKey[]) {
    const findings = collected[key] ?? []
    if (findings.length === 0) continue
    const shown = findings.slice(0, 30)
    const lines = shown.map((f) => `- ${f.label}${f.summary ? ` — ${f.summary}` : ''} (${f.path})`)
    if (findings.length > shown.length) {
      lines.push(`- ...and ${findings.length - shown.length} more`)
    }
    sections.push(`${key.toUpperCase()}\n${lines.join('\n')}`)
  }
  return sections.length > 0
    ? sections.join('\n\n')
    : 'The code extractors returned no findings. You therefore have no basis for a conflict: '
      + 'report none.'
}
