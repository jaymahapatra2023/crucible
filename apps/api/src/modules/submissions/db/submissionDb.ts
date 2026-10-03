/**
 * All SQL for submissions, their validation history and the intake window (P1.2).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type {
  BuildMethod, IntakeHealth, Submission, SubmissionRoute, SubmissionWindow, ValidationEvent,
  ValidationStatus,
} from '../types/submissionTypes.js'

interface Row {
  submission_id: number; team_id: number; team_name: string
  contact_email: string; challenge_id: number
  repo_url: string; build_method: BuildMethod; dockerfile_path: string | null
  build_command: string | null; artifact_urls: string[]; version: number
  is_current: boolean; superseded_by: number | null
  validation_status: ValidationStatus; validation_detail: string | null
  validated_at: Date | null; locked_commit_sha: string | null; locked_at: Date | null
  submitted_at: Date; submitted_by: string | null
  submitted_via: SubmissionRoute; submitted_token_id: number | null
}

const toSubmission = (r: Row): Submission => ({
  submissionId: r.submission_id, teamId: Number(r.team_id),
  teamName: r.team_name, contactEmail: r.contact_email,
  challengeId: r.challenge_id, repoUrl: r.repo_url, buildMethod: r.build_method,
  dockerfilePath: r.dockerfile_path, buildCommand: r.build_command,
  artifactUrls: r.artifact_urls, version: r.version, isCurrent: r.is_current,
  supersededBy: r.superseded_by, validationStatus: r.validation_status,
  validationDetail: r.validation_detail, validatedAt: r.validated_at,
  lockedCommitSha: r.locked_commit_sha, lockedAt: r.locked_at,
  submittedAt: r.submitted_at, submittedBy: r.submitted_by,
  submittedVia: r.submitted_via,
  submittedTokenId: r.submitted_token_id === null ? null : Number(r.submitted_token_id),
})

export async function insertSubmission(input: {
  teamId: number; teamName: string; contactEmail: string; challengeId: number; repoUrl: string
  buildMethod: BuildMethod; dockerfilePath: string | null; buildCommand: string | null
  artifactUrls: string[]; version: number; submittedBy: string | null
  submittedVia: SubmissionRoute; submittedTokenId: number | null
}, client?: DbClient): Promise<Submission> {
  const row = await queryOne<Row>(
    `INSERT INTO submission
       (team_id, team_name, contact_email, challenge_id, repo_url, build_method, dockerfile_path,
        build_command, artifact_urls, version, submitted_by, submitted_via, submitted_token_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13) RETURNING *`,
    [input.teamId, input.teamName, input.contactEmail, input.challengeId, input.repoUrl,
     input.buildMethod, input.dockerfilePath, input.buildCommand, input.artifactUrls,
     input.version, input.submittedBy, input.submittedVia, input.submittedTokenId], client)
  if (!row) throw new Error('insertSubmission returned no row')
  return toSubmission(row)
}

export async function selectSubmission(submissionId: number): Promise<Submission | null> {
  const row = await queryOne<Row>('SELECT * FROM submission WHERE submission_id = $1', [submissionId])
  return row ? toSubmission(row) : null
}

/**
 * The team's standing entry for a challenge, by identity (E17-S02 acceptance 3).
 *
 * Keyed on `team_id`, not on the name. Matching on the name is what made a team that corrected
 * its spelling between versions start a second lineage instead of superseding its own entry.
 */
export async function selectCurrentFor(
  teamId: number, challengeId: number, client?: DbClient,
): Promise<Submission | null> {
  const row = await queryOne<Row>(
    'SELECT * FROM submission WHERE team_id = $1 AND challenge_id = $2 AND is_current',
    [teamId, challengeId], client)
  return row ? toSubmission(row) : null
}

/** Everything a team currently has entered, across challenges (E17-S03). */
export async function selectCurrentForTeam(teamId: number): Promise<Submission[]> {
  const res = await query<Row>(
    `SELECT * FROM submission WHERE team_id = $1 AND is_current
      ORDER BY challenge_id`, [teamId])
  return res.rows.map(toSubmission)
}

/**
 * Stand the previous entry down, before the replacement is inserted.
 *
 * The partial unique index permits one CURRENT row per team and challenge, so inserting first
 * and superseding afterwards fails on the insert — the old row is still current at that moment.
 * `superseded_by` is filled in once the new id exists.
 */
export async function standDown(previousId: number, client?: DbClient): Promise<void> {
  await query(
    'UPDATE submission SET is_current = FALSE WHERE submission_id = $1', [previousId], client)
}

export async function linkSupersededBy(
  previousId: number, newId: number, client?: DbClient,
): Promise<void> {
  await query(
    'UPDATE submission SET superseded_by = $2 WHERE submission_id = $1',
    [previousId, newId], client)
}

export interface SubmissionFilter {
  challengeId?: number
  status?: ValidationStatus
  currentOnly?: boolean
}

function where(f: SubmissionFilter, from: number): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  let i = from
  if (f.currentOnly !== false) parts.push('is_current')
  if (f.challengeId !== undefined) { parts.push(`challenge_id = $${i++}`); params.push(f.challengeId) }
  if (f.status !== undefined) { parts.push(`validation_status = $${i++}`); params.push(f.status) }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/**
 * How an entry list may be ordered (E40).
 *
 * An allow-list mapping to SQL fragments, never a column name taken from the request — sorting is
 * the one place a list like this invites string interpolation. The same shape the review table
 * has used since E08.
 *
 * Every ordering ends with `submission_id DESC` so the sequence is total. Without it, two entries
 * submitted in the same second can swap places between pages and a row is silently seen twice or
 * not at all.
 */
const SORTS: Record<string, string> = {
  submitted: 'submitted_at DESC',
  team: 'lower(team_name) ASC',
  challenge: 'challenge_id ASC, submitted_at DESC',
  status: 'validation_status ASC, submitted_at DESC',
  version: 'version DESC',
}

export const SUBMISSION_SORTS = Object.keys(SORTS)

export async function listSubmissions(
  f: SubmissionFilter, limit: number, offset: number, sort?: string,
): Promise<Submission[]> {
  const { sql, params } = where(f, 3)
  const order = SORTS[sort ?? ''] ?? SORTS['submitted']!
  const res = await query<Row>(
    `SELECT * FROM submission ${sql} ORDER BY ${order}, submission_id DESC
      LIMIT $1 OFFSET $2`, [limit, offset, ...params])
  return res.rows.map(toSubmission)
}

/** What pre-flight last concluded about each entry, for the entries table (E46-S02 acceptance 4). */
export interface PreflightSummary {
  preflightId: number
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  verdict: 'READY' | 'PROBLEMS' | 'UNKNOWN' | null
  commitSha: string | null
  /** Non-passing checks, as `{ key, label, status }`, so a row can name what is wrong. */
  attention: Array<{ key: string; label: string; status: 'FAIL' | 'UNKNOWN' }>
  error: string | null
  noticeStatus: 'SENT' | 'PREPARED' | 'FAILED' | 'UNCHANGED' | null
  finishedAt: Date | null
}

/** Read through preflight's published view, never its tables (P1.3). */
export async function selectPreflightFor(submissionIds: readonly number[]): Promise<Map<number, PreflightSummary>> {
  if (submissionIds.length === 0) return new Map()
  const res = await query<{
    preflight_id: number; submission_id: number; status: PreflightSummary['status']
    verdict: PreflightSummary['verdict']; commit_sha: string | null
    checks: Array<{ key: string; label: string; status: 'PASS' | 'FAIL' | 'UNKNOWN' }>
    error: string | null; notice_status: PreflightSummary['noticeStatus']; finished_at: Date | null
  }>(
    `SELECT preflight_id, submission_id, status, verdict, commit_sha, checks, error,
            notice_status, finished_at
       FROM v_preflight_latest WHERE submission_id = ANY($1::bigint[])`, [submissionIds])
  return new Map(res.rows.map((r) => [Number(r.submission_id), {
    preflightId: Number(r.preflight_id), status: r.status, verdict: r.verdict,
    commitSha: r.commit_sha,
    attention: r.checks.filter((c) => c.status !== 'PASS')
      .map((c) => ({ key: c.key, label: c.label, status: c.status as 'FAIL' | 'UNKNOWN' })),
    error: r.error, noticeStatus: r.notice_status, finishedAt: r.finished_at,
  }]))
}

export async function countSubmissions(f: SubmissionFilter): Promise<number> {
  const { sql, params } = where(f, 1)
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM submission ${sql}`, params)
  return row?.n ?? 0
}

export async function recordValidation(input: {
  submissionId: number; status: ValidationStatus; detail: string
  commitSha: string | null; durationMs: number; normalisedUrl?: string
}): Promise<Submission | null> {
  await query(
    `INSERT INTO submission_validation_event
       (submission_id, status, detail, commit_sha, duration_ms)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.submissionId, input.status, input.detail, input.commitSha, input.durationMs])

  const row = await queryOne<Row>(
    `UPDATE submission
        SET validation_status = $2, validation_detail = $3, validated_at = now(),
            repo_url = COALESCE($4, repo_url)
      WHERE submission_id = $1 RETURNING *`,
    [input.submissionId, input.status, input.detail, input.normalisedUrl ?? null])
  return row ? toSubmission(row) : null
}

export async function selectValidationHistory(submissionId: number): Promise<ValidationEvent[]> {
  const res = await query<{
    event_id: number; submission_id: number; status: ValidationStatus; detail: string | null
    commit_sha: string | null; duration_ms: number | null; checked_at: Date
  }>(
    `SELECT * FROM submission_validation_event WHERE submission_id = $1
      ORDER BY checked_at DESC, event_id DESC LIMIT 100`, [submissionId])
  return res.rows.map((r) => ({
    eventId: r.event_id, submissionId: r.submission_id, status: r.status, detail: r.detail,
    commitSha: r.commit_sha, durationMs: r.duration_ms, checkedAt: r.checked_at,
  }))
}

/**
 * Submissions due for a re-check (E03-S02 acceptance 4).
 *
 * A PENDING entry is always due (E45-S02): it is PENDING because its checks ran out of time,
 * which is a fact about the moment and not about the entry. The receipt promises the team the
 * checks will "run again shortly" — a promise the interval alone would break by an hour.
 */
export async function selectForRevalidation(olderThanMinutes: number, limit: number): Promise<Submission[]> {
  const res = await query<Row>(
    `SELECT * FROM submission
      WHERE is_current AND locked_at IS NULL
        AND (validation_status = 'PENDING'
             OR validated_at IS NULL
             OR validated_at < now() - ($1 || ' minutes')::interval)
      ORDER BY validated_at NULLS FIRST LIMIT $2`,
    [String(olderThanMinutes), limit])
  return res.rows.map(toSubmission)
}

export async function lockSubmission(
  submissionId: number, commitSha: string | null, client?: DbClient,
): Promise<void> {
  await query(
    `UPDATE submission SET locked_commit_sha = $2, locked_at = now() WHERE submission_id = $1`,
    [submissionId, commitSha], client)
}

export async function selectIntakeHealth(): Promise<IntakeHealth[]> {
  const res = await query<{
    challenge_id: number; total: number; valid: number; pending: number
    unreachable: number; private: number; rejected: number
    dockerfile_builds: number; command_builds: number
  }>('SELECT * FROM v_submissions_intake_health ORDER BY challenge_id')
  return res.rows.map((r) => ({
    challengeId: r.challenge_id, total: Number(r.total), valid: Number(r.valid),
    pending: Number(r.pending), unreachable: Number(r.unreachable),
    private: Number(r.private), rejected: Number(r.rejected),
    dockerfileBuilds: Number(r.dockerfile_builds), commandBuilds: Number(r.command_builds),
  }))
}

interface WindowRow {
  window_id: number; name: string; opens_at: Date; closes_at: Date
  locked_at: Date | null; locked_by: string | null
}

const toWindow = (r: WindowRow): SubmissionWindow => ({
  windowId: r.window_id, name: r.name, opensAt: r.opens_at, closesAt: r.closes_at,
  lockedAt: r.locked_at, lockedBy: r.locked_by,
})

export async function insertWindow(input: {
  name: string; opensAt: Date; closesAt: Date
}): Promise<SubmissionWindow> {
  const row = await queryOne<WindowRow>(
    `INSERT INTO submission_window (name, opens_at, closes_at) VALUES ($1,$2,$3) RETURNING *`,
    [input.name, input.opensAt, input.closesAt])
  if (!row) throw new Error('insertWindow returned no row')
  return toWindow(row)
}

/**
 * Correct an unlocked window's name or times.
 *
 * Only while unlocked. Locking is the act that makes "the deadline has passed" mean something
 * (E38), and a deadline that can move after the lock would make it mean nothing.
 */
export async function updateWindow(input: {
  windowId: number; name: string; opensAt: Date; closesAt: Date
}): Promise<SubmissionWindow | null> {
  const row = await queryOne<WindowRow>(
    `UPDATE submission_window
        SET name = $2, opens_at = $3, closes_at = $4
      WHERE window_id = $1 AND locked_at IS NULL
      RETURNING *`,
    [input.windowId, input.name, input.opensAt, input.closesAt])
  return row ? toWindow(row) : null
}

/** The open (unlocked) window, if there is one. */
export async function selectOpenWindow(): Promise<SubmissionWindow | null> {
  const row = await queryOne<WindowRow>(
    'SELECT * FROM submission_window WHERE locked_at IS NULL ORDER BY window_id DESC LIMIT 1')
  return row ? toWindow(row) : null
}

/**
 * The most recent window, locked or not.
 *
 * Intake status must keep reporting LOCKED after a lock. Deriving status from the *unlocked*
 * window alone made a locked event indistinguishable from one that never had a window at all.
 */
export async function selectLatestWindow(): Promise<SubmissionWindow | null> {
  const row = await queryOne<WindowRow>(
    'SELECT * FROM submission_window ORDER BY window_id DESC LIMIT 1')
  return row ? toWindow(row) : null
}

export async function markWindowLocked(
  windowId: number, actor: string, client?: DbClient,
): Promise<SubmissionWindow | null> {
  const row = await queryOne<WindowRow>(
    `UPDATE submission_window SET locked_at = now(), locked_by = $2
      WHERE window_id = $1 AND locked_at IS NULL RETURNING *`,
    [windowId, actor], client)
  return row ? toWindow(row) : null
}
