/**
 * Running and persisting build probes (E05-S04).
 *
 * The prober package owns containment; this service owns what the package deliberately refuses:
 * configuration, cloning, persistence and the rule that a harness failure is never scored
 * against a team.
 */
import { gradeRuns, probe, type ProbeResult, type SandboxPolicy } from '@crucible/prober'
import { withClone } from '@crucible/scanner'
import { AppError, errorMessage } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { queryOne } from '../../../db/pool.js'
import { getJson, getNumber, isEnabled } from '../../platform/services/configService.js'
import {
  insertProbe, selectCurrentProbe, selectRunsInput, supersedeProbe, type ProbeRow,
} from '../db/probeDb.js'

const log = createLogger('probes', 'probeService')

/** Read through the submissions module's published view, never its table (P1.3). */
async function submissionFor(submissionId: number) {
  return queryOne<{
    submission_id: number; team_name: string; repo_url: string
    build_method: 'DOCKERFILE' | 'COMMAND'; dockerfile_path: string | null
    build_command: string | null; validation_status: string; locked_commit_sha: string | null
  }>(
    `SELECT submission_id, team_name, repo_url, build_method, dockerfile_path,
            build_command, validation_status, locked_commit_sha
       FROM v_submissions_submission WHERE submission_id = $1`,
    [submissionId])
}

/**
 * The dominant language, recorded at scan time. Used to pick a base image on the COMMAND path.
 *
 * Reads the persisted `primary_language` rather than picking from the language list: that list
 * is alphabetical, so a TypeScript project with one shell script could be built in the wrong
 * image purely because of ordering.
 */
async function languageFor(submissionId: number): Promise<string | undefined> {
  const row = await queryOne<{ primary_language: string | null }>(
    'SELECT primary_language FROM v_scans_latest WHERE submission_id = $1', [submissionId])
  return row?.primary_language ?? undefined
}

export async function currentPolicy(): Promise<SandboxPolicy> {
  return {
    timeoutMs: await getNumber('probes.timeout_ms'),
    settleSeconds: await getNumber('probes.settle_seconds'),
    memoryMb: await getNumber('probes.memory_mb'),
    cpus: await getNumber('probes.cpus'),
    pidsLimit: await getNumber('probes.pids_limit'),
    logCapBytes: await getNumber('probes.log_cap_bytes'),
    egressAllowList: await getJson<string[]>('probes.egress_allow_list'),
  }
}

export interface ProbeOptions {
  submissionId: number
  force?: boolean
  runId?: number
  actor?: string
}

export interface ProbeOutcome {
  probe: Omit<ProbeRow, 'log'>
  skipped: boolean
}

export async function probeSubmission(options: ProbeOptions): Promise<ProbeOutcome> {
  const submission = await submissionFor(options.submissionId)
  if (!submission) {
    throw new AppError('NOT_FOUND', `Submission ${options.submissionId} was not found.`)
  }
  if (submission.validation_status !== 'VALID') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Submission ${options.submissionId} is ${submission.validation_status}; only a repository ` +
        `that validated can be probed.`,
    )
  }

  const existing = await selectCurrentProbe(options.submissionId)
  if (existing && !options.force) {
    return { probe: existing, skipped: true }
  }

  if (!(await isEnabled('feature.probes.enabled'))) {
    // Recorded as UNSUPPORTED, never as a failure: no team is scored down for a capability the
    // operator switched off.
    const disabled = await persistDisabled(options, submission.build_method)
    return { probe: disabled, skipped: false }
  }

  const policy = await currentPolicy()
  const language = await languageFor(options.submissionId)

  let result: ProbeResult
  try {
    result = await withClone(
      submission.repo_url,
      {
        historyDepth: 1, timeoutMs: policy.timeoutMs,
        // The locked commit after the window closes (E50): the build must be of what was judged.
        ...(submission.locked_commit_sha !== null && { commit: submission.locked_commit_sha }),
      },
      async (clone) => probe({
        repoPath: clone.path,
        buildMethod: submission.build_method,
        ...(submission.dockerfile_path !== null && { dockerfilePath: submission.dockerfile_path }),
        ...(submission.build_command !== null && { buildCommand: submission.build_command }),
        ...(language !== undefined && { language }),
        policy,
        ...(options.runId !== undefined && { correlationId: String(options.runId) }),
      }),
    )
  } catch (err) {
    // Cloning failed, so the probe never ran. A harness or availability problem, not a build
    // failure — recorded as PROBE_ERROR so scoring excludes it rather than scoring it zero.
    log.error('probe could not start', { submissionId: options.submissionId, err })
    result = {
      outcome: 'PROBE_ERROR', method: submission.build_method, buildExitCode: null,
      buildDurationMs: 0, stayedUp: false, runDurationMs: 0, timedOut: false,
      resourceExceeded: false, log: '', logTruncated: false, logBytes: 0,
      egressAllowed: policy.egressAllowList, baseImage: null, sandboxBlock: null,
      probeError: `The repository could not be prepared for probing: ${errorMessage(err)}`,
      ranAt: new Date().toISOString(), totalDurationMs: 0,
    }
  }

  if (existing) await supersedeProbe(existing.probe_id)

  const grade = gradeRuns(result)
  const row = await insertProbe({
    submissionId: options.submissionId,
    scanId: null,
    result,
    grade,
    policy,
    runId: options.runId ?? null,
  })

  await recordAudit({
    actor: options.actor ?? 'system',
    action: 'probes.probe_completed',
    subjectType: 'submission',
    subjectId: String(options.submissionId),
    payload: {
      probeId: row.probe_id, outcome: result.outcome, grade: grade.grade,
      method: result.method, egressAllowed: result.egressAllowed,
      durationMs: result.totalDurationMs,
    },
  })

  log.info('submission probed', {
    submissionId: options.submissionId, outcome: result.outcome,
    grade: grade.grade, durationMs: result.totalDurationMs,
  })

  return { probe: row, skipped: false }
}

async function persistDisabled(
  options: ProbeOptions, method: 'DOCKERFILE' | 'COMMAND',
): Promise<Omit<ProbeRow, 'log'>> {
  const policy = await currentPolicy()
  const result: ProbeResult = {
    outcome: 'UNSUPPORTED_STACK', method, buildExitCode: null, buildDurationMs: 0,
    stayedUp: false, runDurationMs: 0, timedOut: false, resourceExceeded: false,
    log: '', logTruncated: false, logBytes: 0, egressAllowed: [], baseImage: null,
    sandboxBlock: null,
    probeError: 'Build probing is disabled, so this submission was not built.',
    ranAt: new Date().toISOString(), totalDurationMs: 0,
  }
  return insertProbe({
    submissionId: options.submissionId, scanId: null, result,
    grade: gradeRuns(result), policy, runId: options.runId ?? null,
  })
}

/**
 * The Runs dimension input for scoring.
 *
 * Returns null when no probe exists. E07-S01 then marks the dimension PARTIAL rather than
 * scoring it zero — an unprobed submission is unmeasured, not failing.
 */
export async function runsDimensionInput(submissionId: number) {
  return selectRunsInput(submissionId)
}
