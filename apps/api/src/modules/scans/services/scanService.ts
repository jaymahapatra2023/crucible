/**
 * Scanning a submission and persisting the result (E04-S03, E04-S05, E04-S06).
 *
 * The scanner package does the work; this service owns the parts the package deliberately
 * refuses: cloning, persistence, configuration and flagging. That split is what lets the
 * scanner be tested against any directory with nothing running.
 */
import { createHash } from 'node:crypto'
import {
  analyseProvenance, flagProvenance, primaryLanguage, scanRepository, withClone,
  type ScanDepth, type ScanResult,
} from '@crucible/scanner'
import { AppError, errorMessage } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { getJson, getNumber, getString, isEnabled } from '../../platform/services/configService.js'
import { eventWindowSchema } from '../../platform/services/configSchemas.js'
import { queryOne } from '../../../db/pool.js'
import {
  insertFailedScan, insertScan, selectLatestScan, selectRawResult, selectScanAtCommit,
  supersedeScan, upsertProvenance, type ScanRow,
} from '../db/scanDb.js'

const log = createLogger('scans', 'scanService')

/** Read through the submissions module's published view, never its table (P1.3). */
async function submissionFor(submissionId: number): Promise<{
  submissionId: number; teamName: string; repoUrl: string
  validationStatus: string; lockedCommitSha: string | null
} | null> {
  const row = await queryOne<{
    submission_id: number; team_name: string; repo_url: string
    validation_status: string; locked_commit_sha: string | null
  }>(
    `SELECT submission_id, team_name, repo_url, validation_status, locked_commit_sha
       FROM v_submissions_submission WHERE submission_id = $1`,
    [submissionId])
  if (!row) return null
  return {
    submissionId: row.submission_id, teamName: row.team_name, repoUrl: row.repo_url,
    validationStatus: row.validation_status, lockedCommitSha: row.locked_commit_sha,
  }
}

export interface ScanOptions {
  submissionId: number
  depth?: ScanDepth
  /** Re-scan even if this commit was already scanned (E04-S03 acceptance 3). */
  force?: boolean
  runId?: number
  actor?: string
}

export interface ScanOutcome {
  scan: ScanRow
  /** True when an existing scan at the same commit was reused instead of re-scanning. */
  skipped: boolean
}

export async function scanSubmission(options: ScanOptions): Promise<ScanOutcome> {
  const submission = await submissionFor(options.submissionId)
  if (!submission) {
    throw new AppError('NOT_FOUND', `Submission ${options.submissionId} was not found.`)
  }
  if (submission.validationStatus !== 'VALID') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Submission ${options.submissionId} is ${submission.validationStatus}; only a repository ` +
        `that validated can be scanned.`,
    )
  }

  const depth = options.depth ?? ((await getString('scans.default_depth')) as ScanDepth)
  const timeoutMs = await getNumber('scans.clone_timeout_ms')
  const historyDepth = await getString('scans.history_depth')
  const runId = options.runId ?? null

  try {
    return await withClone(
      submission.repoUrl,
      {
        historyDepth: historyDepth === 'full' ? 'full' : Number(historyDepth),
        timeoutMs,
        // The locked commit, once the window has closed. Before that, HEAD — which is what
        // pre-flight should see. This field was read and not used until the E50 review: every
        // evaluation cloned whatever the default branch held on the night.
        ...(submission.lockedCommitSha !== null && { commit: submission.lockedCommitSha }),
      },
      async (clone) => {
        // Re-scanning the same commit produces the same answer, so it is skipped unless forced.
        const existing = clone.commitSha
          ? await selectScanAtCommit(options.submissionId, clone.commitSha)
          : null

        if (existing && !options.force) {
          log.info('scan skipped — this commit was already scanned', {
            submissionId: options.submissionId, commitSha: clone.commitSha,
          })
          return { scan: existing, skipped: true }
        }
        if (existing) {
          // Forced: keep the previous scan as evidence, but stand it down so exactly one
          // current scan exists per commit.
          await supersedeScan(existing.scan_id, null)
        }

        const eventWindow = await readEventWindow()
        const result = await scanRepository({
          repoPath: clone.path,
          depth,
          ...(eventWindow !== null && { eventWindow }),
        })

        const scan = await persist(options.submissionId, result, runId)
        // Link the chain so an appeal can follow which scan replaced which.
        if (existing) await supersedeScan(existing.scan_id, scan.scan_id)
        await recordProvenance(options.submissionId, scan.scan_id, clone.path, eventWindow)

        await recordAudit({
          actor: options.actor ?? 'system',
          action: 'scans.scan_completed',
          subjectType: 'submission',
          subjectId: String(options.submissionId),
          payload: {
            scanId: scan.scan_id, commitSha: result.commitSha, depth,
            filesAnalysed: result.filesAnalysed, filesTotal: result.filesTotal,
            budgetTruncated: result.budgetTruncated,
          },
        })

        log.info('submission scanned', {
          submissionId: options.submissionId, scanId: scan.scan_id,
          files: `${result.filesAnalysed}/${result.filesTotal}`,
          truncated: result.budgetTruncated, durationMs: result.durationMs,
        })
        return { scan, skipped: false }
      },
    )
  } catch (err) {
    // A failed scan is recorded, not swallowed: E10-S04 needs the failure to appear in the run
    // summary rather than as a submission that silently has no scan.
    const failed = await insertFailedScan({
      submissionId: options.submissionId, depth, error: errorMessage(err), runId,
    })
    log.error('scan failed', { submissionId: options.submissionId, err })
    throw new AppError(
      'INTERNAL_ERROR',
      `Scanning submission ${options.submissionId} failed: ${errorMessage(err)}`,
      { details: { scanId: failed.scan_id }, cause: err },
    )
  }
}

async function persist(
  submissionId: number, result: ScanResult, runId: number | null,
): Promise<ScanRow> {
  const contentHash = createHash('sha256')
    .update(JSON.stringify(result.files.map((f) => [f.path, f.content])))
    .digest('hex')
  return insertScan({
    submissionId,
    result,
    contentHash,
    // The dominant language by file count. Needed by the prober to choose a base image, and
    // recorded here so that choice never depends on list ordering.
    primaryLanguage: primaryLanguage(result.stats),
    runId,
  })
}

async function recordProvenance(
  submissionId: number,
  scanId: number,
  repoPath: string,
  eventWindow: { startsAt: Date; endsAt: Date } | null,
): Promise<void> {
  if (!(await isEnabled('feature.scans.provenance'))) return

  const provenance = await analyseProvenance(
    repoPath, eventWindow ?? undefined).catch(() => null)
  if (!provenance) {
    log.info('no readable history; provenance not recorded', { submissionId })
    return
  }

  const flags = flagProvenance(provenance, {
    maxOutOfWindowPct: await getNumber('scans.provenance_max_out_of_window_pct'),
    maxSingleCommitPct: await getNumber('scans.provenance_max_single_commit_pct'),
  })

  await upsertProvenance({ submissionId, scanId, provenance, flags })

  if (flags.length > 0) {
    // Flagged for review, never excluded (E04-S06 acceptance 2).
    log.info('provenance flagged for human review', {
      submissionId, flags: flags.map((f) => f.code),
    })
  }
}

/**
 * The event window, parsed by the same schema the writer enforces (E37).
 *
 * This used to hand-roll the check and return null on anything it disliked, which made "no window
 * configured" and "the window is malformed" the same outcome: windowing silently off, one
 * `log.warn`, every commit counted as in-window on an outcome-affecting setting.
 *
 * `setConfig` now refuses a malformed value, so this can only be reached by a direct write to the
 * database. It stays as defence in depth — and it logs at ERROR, because at this point something
 * bypassed the writer.
 */
async function readEventWindow(): Promise<{ startsAt: Date; endsAt: Date } | null> {
  const raw = await getJson<unknown>('scans.event_window')
  const parsed = eventWindowSchema.safeParse(raw)
  if (!parsed.success) {
    log.error('scans.event_window is malformed; provenance windowing is DISABLED', {
      problems: parsed.error.issues.map((i) => i.message),
    })
    return null
  }
  if (parsed.data === null) return null
  return { startsAt: new Date(parsed.data.startsAt), endsAt: new Date(parsed.data.endsAt) }
}

/**
 * The persisted scan for a submission.
 *
 * Scoring calls this. It never triggers a scan (E04-S05 acceptance 2): a scoring run that could
 * silently scan would make cost, timing and the evaluated commit unpredictable.
 */
export async function persistedScan(submissionId: number): Promise<ScanResult> {
  return (await persistedScanRef(submissionId)).result
}

/**
 * The same scan, with the identity of the row it came from.
 *
 * Discovery (E12) records which scan it described, so a description can be shown against the
 * commit it was read from rather than against whatever has been scanned since. It asks through
 * this module rather than reading `scan` itself: the scan tables are this module's (P1.3).
 */
export async function persistedScanRef(submissionId: number): Promise<{
  scanId: number
  commitSha: string | null
  result: ScanResult
}> {
  const scan = await selectLatestScan(submissionId)
  if (!scan) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Submission ${submissionId} has no completed scan. Scan it before scoring — scoring never ` +
        `scans implicitly.`,
    )
  }
  const raw = await selectRawResult(scan.scan_id)
  if (!raw) {
    throw new AppError('INTERNAL_ERROR', `Scan ${scan.scan_id} has no stored result.`)
  }
  return { scanId: Number(scan.scan_id), commitSha: raw.commitSha, result: raw }
}

export async function hasScan(submissionId: number): Promise<boolean> {
  return (await selectLatestScan(submissionId)) !== null
}
