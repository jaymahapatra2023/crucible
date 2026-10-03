/**
 * The check runners (E46-S01 acceptance 2): each calls the SAME service the batch orchestrator
 * calls, and none reimplements a stage. What this file owns is the translation from a service's
 * outcome — or its failure — into PASS, FAIL or UNKNOWN with words a team can act on.
 *
 * A thrown error from a stage is UNKNOWN, never FAIL. The services throw for harness reasons
 * (a clone that timed out, Docker unavailable, discovery switched off); a team's own problems
 * come back as recorded outcomes, and those are the only things that FAIL.
 */
import { findCommittedSecrets, describeSecret, type ScanResult } from '@crucible/scanner'
import { originalitySignals } from '@crucible/scoring'
import { errorMessage } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { queryOne } from '../../../db/pool.js'
import { getNumber, isEnabled } from '../../platform/services/configService.js'
import { persistedScan, scanSubmission } from '../../scans/services/scanService.js'
import { currentPolicy, probeSubmission } from '../../probes/services/probeService.js'
import { discoverSubmission } from '../../discovery/services/discoveryService.js'
import type { CheckRecord } from '../db/preflightDb.js'
import { check, probeChecks, unknown } from './preflightVerdict.js'

const log = createLogger('preflight', 'checks')

export interface CheckContext {
  submissionId: number
  runId: number
  actor: string
  force: boolean
}

export interface ScanCheck {
  record: CheckRecord
  scanId: number | null
  commitSha: string | null
  /** The persisted result, for the checks that read it. Null when the scan did not complete. */
  result: ScanResult | null
}

export async function runScanCheck(ctx: CheckContext): Promise<ScanCheck> {
  try {
    const outcome = await scanSubmission({
      submissionId: ctx.submissionId, runId: ctx.runId, actor: ctx.actor, force: ctx.force,
    })
    const result = await persistedScan(ctx.submissionId)
    const summary = outcome.skipped
      ? 'The repository was read earlier at this commit; that reading was reused.'
      : `The repository was read: ${result.filesAnalysed} of ${result.filesTotal} files`
        + (result.budgetTruncated ? ' (the largest were cut short by the file budget).' : '.')
    return {
      record: check('scan', 'PASS', summary, { detail: { reused: outcome.skipped } }),
      scanId: Number(outcome.scan.scan_id), commitSha: outcome.scan.commit_sha, result,
    }
  } catch (err) {
    log.warn('scan could not be completed for pre-flight', { submissionId: ctx.submissionId, err })
    return {
      record: unknown('scan', `the repository could not be read at scan depth: ${errorMessage(err)}`),
      scanId: null, commitSha: null, result: null,
    }
  }
}

/**
 * Whether history could be read at all.
 *
 * Provenance FLAGS (work outside the window, one giant commit) are for the organiser's review
 * queue, where a human decides what they mean (E04-S06). They are not reported to the team:
 * a check that told a team which pattern of commits looks suspicious would be teaching it.
 */
export function provenanceCheck(scan: ScanResult | null): CheckRecord {
  if (!scan) return unknown('provenance', 'the repository was not read, so its history was not either.')
  const p = scan.provenance
  if (!p || p.totalCommits === 0) {
    return unknown('provenance', 'no commit history could be read.')
  }
  return check('provenance', 'PASS',
    `${p.totalCommits} commit${p.totalCommits === 1 ? '' : 's'} by `
    + `${p.distinctAuthors} author${p.distinctAuthors === 1 ? '' : 's'} were read.`,
    { detail: { historyTruncated: p.historyTruncated } })
}

/**
 * Whether there is something to evaluate (moved here from tier 1 in the E50 review).
 *
 * A missing README or a scaffold with no written code used to REFUSE the submission. Refusing
 * meant an entry that existed could never be evaluated; telling the team, with what to change,
 * lets them fix it while they can — and on the night an incomplete entry is still judged on what
 * is there. "Substantive" is the evaluator's own measure (`originalitySignals`), so the number
 * the team is told is the number the scorecard will use.
 */
export async function substanceCheck(scan: ScanResult | null): Promise<CheckRecord> {
  if (!scan) return unknown('substance', 'the repository was not read, so its contents could not be judged.')
  const minLines = await getNumber('submissions.tier1_min_code_lines')
  const substantive = originalitySignals(scan).boilerplate.substantiveLines
  const problems: string[] = []
  const hasReadme = scan.markers?.hasReadme ?? scan.metrics.hasReadme
  if (!hasReadme) {
    problems.push('No README was found at the repository root — the evaluators read it first.')
  }
  if (substantive < minLines) {
    problems.push(`Only ${substantive} lines of code were found outside generated and configuration `
      + `files; an entry needs at least ${minLines} to be judged on its own work.`)
  }
  if (problems.length === 0) {
    return check('substance', 'PASS',
      `A README and ${substantive} lines of written code were found.`, { detail: { substantive } })
  }
  return check('substance', 'FAIL', problems.join(' '), {
    remedy: (hasReadme ? '' : 'Add a README that says what the project is and how to run it. ')
      + (substantive < minLines ? 'If your work is on another branch, push it to the default branch. ' : '')
      + 'Then submit again.',
    detail: { substantive, hasReadme, minLines },
  })
}

export async function runProbeChecks(ctx: CheckContext): Promise<[CheckRecord, CheckRecord]> {
  try {
    const [outcome, policy] = await Promise.all([
      probeSubmission({
        submissionId: ctx.submissionId, runId: ctx.runId, actor: ctx.actor, force: ctx.force,
      }),
      currentPolicy(),
    ])
    const p = outcome.probe
    const [build, run] = probeChecks({
      outcome: p.outcome, exitCode: p.exit_code, stayedUp: p.stayed_up, timedOut: p.timed_out,
      resourceExceeded: p.resource_exceeded, probeError: p.probe_error,
      runDurationMs: p.run_duration_ms,
    }, policy.settleSeconds)
    const detail = { probeId: Number(p.probe_id), outcome: p.outcome, reused: outcome.skipped }
    return [{ ...build, detail }, { ...run, detail }]
  } catch (err) {
    log.warn('probe could not be completed for pre-flight', { submissionId: ctx.submissionId, err })
    const reason = `the build could not be attempted: ${errorMessage(err)}`
    return [unknown('build', reason), unknown('run', reason)]
  }
}

/**
 * Discovery, when configured (feature.preflight.discovery).
 *
 * Reuses a description already made from this scan rather than paying for another: seven model
 * calls per submission is the cost decision the flag exists to make, and an organiser re-running
 * pre-flight on an unchanged commit should not pay it twice.
 */
export async function runDiscoveryCheck(ctx: CheckContext, scanId: number | null): Promise<CheckRecord> {
  if (scanId === null) {
    return unknown('discovery', 'the repository was not read, so it could not be described.')
  }
  if (!ctx.force) {
    const existing = await queryOne<{ discovery_id: number; status: string }>(
      `SELECT discovery_id, status FROM v_discovery_current
        WHERE submission_id = $1 AND scan_id = $2 AND status = 'COMPLETED'`,
      [ctx.submissionId, scanId])
    if (existing) {
      return check('discovery', 'PASS', 'The repository was described earlier at this commit.',
        { detail: { discoveryId: Number(existing.discovery_id), reused: true } })
    }
  }
  try {
    const outcome = await discoverSubmission({
      submissionId: ctx.submissionId, actor: ctx.actor, runId: ctx.runId,
    })
    if (outcome.status === 'COMPLETED' && outcome.usable && !outcome.paused) {
      return check('discovery', 'PASS', 'The repository could be read and described.',
        { detail: { discoveryId: outcome.discoveryId, reused: false } })
    }
    return unknown('discovery',
      outcome.paused ?? 'the description did not complete.', { discoveryId: outcome.discoveryId })
  } catch (err) {
    log.warn('discovery could not be completed for pre-flight', { submissionId: ctx.submissionId, err })
    return unknown('discovery', `the repository could not be described: ${errorMessage(err)}`)
  }
}

/** Whether the discovery check runs at all this time. Both flags, so the batch's rule holds. */
export async function discoveryConfigured(): Promise<boolean> {
  return (await isEnabled('feature.preflight.discovery')) && (await isEnabled('feature.discovery.enabled'))
}

/**
 * Committed credentials, from the files the scan already read.
 *
 * The finding names the file, the line and the kind — never the value (P8.3). A key that was
 * committed and then removed is still in history; the remedy says so, because "delete the line"
 * is the fix a team reaches for and it is not enough.
 */
export function secretsCheck(scan: ScanResult | null): CheckRecord {
  if (!scan) return unknown('secrets', 'the repository was not read, so it could not be searched.')
  const findings = findCommittedSecrets(scan.files)
  if (findings.length === 0) {
    return check('secrets', 'PASS', `Nothing in ${scan.files.length} files looked like a committed credential.`)
  }
  const shown = findings.slice(0, 5).map(describeSecret)
  const more = findings.length > 5 ? ` and ${findings.length - 5} more` : ''
  return check('secrets', 'FAIL',
    `Something that looks like a credential is committed: ${shown.join('; ')}${more}.`, {
      remedy: 'Remove it from the repository, ROTATE it (it is in your history and evaluators '
        + 'will read the files), load it from the environment instead, and submit again.',
      detail: { count: findings.length, paths: [...new Set(findings.map((f) => f.path))] },
    })
}
