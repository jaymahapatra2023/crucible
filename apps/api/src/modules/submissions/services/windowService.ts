/**
 * Submission window and lock (E03-S04).
 *
 * At lock, the HEAD commit of every valid submission is recorded. That single act is what makes
 * "the evaluated artifact is the submitted one" true: without it, a team could push after the
 * deadline and be scored on work done afterwards, and nobody could prove otherwise.
 */
import { AppError } from '../../../lib/appError.js'
import { purgeTokenCiphers } from './tokenReveal.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { getNumber } from '../../platform/services/configService.js'
import {
  insertWindow, updateWindow, listSubmissions, lockSubmission, markWindowLocked, selectLatestWindow,
  selectOpenWindow,
} from '../db/submissionDb.js'
import { withTempDir, shallowClone, headSha } from './gitClient.js'
import type { SubmissionWindow } from '../types/submissionTypes.js'

const log = createLogger('submissions', 'window')

export async function openWindow(input: {
  name: string; opensAt: Date; closesAt: Date; actor: string
}): Promise<SubmissionWindow> {
  if (input.closesAt <= input.opensAt) {
    throw new AppError('VALIDATION_FAILED', 'The window must close after it opens.')
  }

  /*
   * An existing unlocked window is CHANGED rather than refused.
   *
   * Refusing it left an organiser who had typed the wrong deadline with only one way out —
   * locking intake, which is permanent and ends the event's submissions. The screen offered a
   * "Change the window" button the API would not honour. Two open windows are still impossible,
   * which was the real point of the refusal.
   *
   * A locked window is not changed: locking is what makes "the deadline has passed" mean
   * something (E38), so the times stop moving at that point.
   */
  const existing = await selectOpenWindow()
  if (existing) {
    const changed = await updateWindow({ windowId: existing.windowId, ...input })
    if (!changed) {
      throw new AppError('CONFLICT',
        'That window was locked a moment ago, so its dates can no longer be changed.')
    }
    await recordAudit({
      actor: input.actor, action: 'submissions.window_changed',
      subjectType: 'submission_window', subjectId: String(changed.windowId),
      payload: {
        from: { name: existing.name, opensAt: existing.opensAt, closesAt: existing.closesAt },
        to: { name: changed.name, opensAt: changed.opensAt, closesAt: changed.closesAt },
      },
    })
    log.info('intake window changed', { windowId: changed.windowId, closesAt: changed.closesAt })
    return changed
  }

  const window = await insertWindow(input)
  await recordAudit({
    actor: input.actor, action: 'submissions.window_opened', subjectType: 'submission_window',
    subjectId: String(window.windowId),
    payload: { name: window.name, opensAt: window.opensAt, closesAt: window.closesAt },
  })
  return window
}

export async function currentWindow(): Promise<SubmissionWindow | null> {
  return selectOpenWindow()
}

/**
 * When entries stop being accepted, worded once.
 *
 * Several messages quote this deadline — the code a team is sent at registration, the coach's
 * notice, the reminder an organiser sends on the night — and they have to agree with each other
 * and with what the system actually enforces. Written here, beside the window it reads, so a
 * change to the deadline moves every message that mentions it.
 *
 * Eastern because that is where the event is, and named in the string so nobody has to guess
 * which nine o'clock is meant.
 */
export async function deadlineWording(): Promise<string> {
  const open = await selectOpenWindow()
  if (!open) return 'the deadline'
  return new Date(open.closesAt).toLocaleString('en-GB', {
    timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short',
  }) + ' (Eastern)'
}

export type IntakeState = 'NO_WINDOW' | 'NOT_YET_OPEN' | 'OPEN' | 'CLOSED' | 'LOCKED'

export interface IntakeStatus {
  state: IntakeState
  window: SubmissionWindow | null
  /** What to tell a team, in plain language (P5.4). */
  message: string
}

export async function intakeStatus(now = new Date()): Promise<IntakeStatus> {
  // The latest window, locked or not — a locked event must report LOCKED, not "no window".
  const window = await selectLatestWindow()
  if (!window) {
    return { state: 'NO_WINDOW', window: null, message: 'Submissions are not open yet.' }
  }
  if (window.lockedAt) {
    return { state: 'LOCKED', window, message: 'Submissions are locked. The deadline has passed.' }
  }
  if (now < window.opensAt) {
    return {
      state: 'NOT_YET_OPEN', window,
      message: `Submissions open at ${window.opensAt.toISOString()}.`,
    }
  }
  if (now > window.closesAt) {
    return {
      state: 'CLOSED', window,
      message: `Submissions closed at ${window.closesAt.toISOString()}.`,
    }
  }
  return {
    state: 'OPEN', window,
    message: `Submissions are open until ${window.closesAt.toISOString()}.`,
  }
}

/** Throw unless intake is open. Used by every write path (E03-S04 acceptance 1). */
export async function assertIntakeOpen(): Promise<void> {
  const status = await intakeStatus()
  if (status.state !== 'OPEN') {
    throw new AppError('WINDOW_CLOSED', status.message)
  }
}

export interface LockResult {
  window: SubmissionWindow
  locked: number
  /** Submissions whose HEAD could not be read at lock time — visible, never silently skipped. */
  failures: Array<{ submissionId: number; teamName: string; reason: string }>
}

/**
 * Close intake and record the evaluated commit for every valid submission.
 *
 * A submission whose HEAD cannot be read is still locked, with a null SHA and a recorded
 * failure. Refusing to lock the window because one repository went private in the last minute
 * would leave intake open past the deadline, which is worse.
 */
export async function lockWindow(actor: string): Promise<LockResult> {
  const window = await selectOpenWindow()
  if (!window) throw new AppError('NOT_FOUND', 'There is no open intake window to lock.')

  const timeoutMs = await getNumber('submissions.clone_timeout_ms')
  const submissions = await listSubmissions({ status: 'VALID' }, 1000, 0)
  const failures: LockResult['failures'] = []
  let locked = 0

  for (const submission of submissions) {
    const sha = await readHead(submission.repoUrl, timeoutMs)
    if (!sha) {
      failures.push({
        submissionId: submission.submissionId,
        teamName: submission.teamName,
        reason: 'The repository HEAD could not be read at lock time.',
      })
    }
    await lockSubmission(submission.submissionId, sha)
    locked++

    // Per submission, with the SHA (E09-S01 acceptance 1, "submission locked"). The commit a
    // team is judged on is the single most disputable fact in intake, and the submission row
    // holds only the current value — this is the record that it was set, when, and to what.
    await recordAudit({
      actor, action: 'submissions.commit_locked', subjectType: 'submission',
      subjectId: String(submission.submissionId),
      payload: {
        windowId: window.windowId,
        teamName: submission.teamName,
        repoUrl: submission.repoUrl,
        lockedCommitSha: sha,
        ...(sha === null && { note: 'HEAD could not be read at lock time.' }),
      },
    })
  }

  const lockedWindow = await markWindowLocked(window.windowId, actor)
  if (!lockedWindow) throw new AppError('CONFLICT', 'The window was locked by someone else.')

  // Nothing is revealable after lock (ADR 0005 §4): the stored copies go with the window.
  await purgeTokenCiphers({ reason: `intake window ${window.windowId} locked`, actor })

  await recordAudit({
    actor, action: 'submissions.window_locked', subjectType: 'submission_window',
    subjectId: String(window.windowId),
    payload: { locked, failures },
  })
  log.info('intake window locked', { windowId: window.windowId, locked, failures: failures.length })

  return { window: lockedWindow, locked, failures }
}

async function readHead(repoUrl: string, timeoutMs: number): Promise<string | null> {
  return withTempDir(async (dir) => {
    const clone = await shallowClone(repoUrl, `${dir}/repo`, timeoutMs)
    if (!clone.ok) return null
    return headSha(`${dir}/repo`)
  })
}
