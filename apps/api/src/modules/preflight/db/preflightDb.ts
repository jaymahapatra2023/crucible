/**
 * All SQL for pre-flight runs and notices (P1.2).
 *
 * `submission_id` and `team_id` are plain columns (ADR 0002). Nothing here joins another
 * module's table; what the orchestrator needs about a submission it reads through the published
 * views.
 */
import { query, queryOne } from '../../../db/pool.js'
import type { DeliveryChannel } from '../../../lib/ports/mailPort.js'

export type PreflightStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
export type Verdict = 'READY' | 'PROBLEMS' | 'UNKNOWN'
export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface CheckRecord {
  key: string
  label: string
  status: CheckStatus
  /** What was observed, for the team. Never a score, never the matched secret. */
  summary: string
  /** What to do about it. Null when there is nothing to do. */
  remedy: string | null
  detail?: Record<string, unknown>
}

export interface PreflightRow {
  preflightId: number
  submissionId: number
  teamId: number
  commitSha: string | null
  status: PreflightStatus
  verdict: Verdict | null
  checks: CheckRecord[]
  skipped: string[]
  ledgerRunId: number | null
  triggeredBy: string
  forced: boolean
  error: string | null
  queuedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export type NoticeStatus = 'SENT' | 'PREPARED' | 'FAILED' | 'UNCHANGED'

export interface NoticeRow {
  noticeId: number
  preflightId: number
  teamId: number
  mailKey: string
  status: NoticeStatus
  provider: string
  detail: string | null
  providerRef: string | null
  templateVersion: number | null
  /** What carried it (E49). */
  channel: DeliveryChannel
  sentAt: Date | null
}

interface Row {
  preflight_id: number; submission_id: number; team_id: number; commit_sha: string | null
  status: PreflightStatus; verdict: Verdict | null; checks: CheckRecord[]; skipped: string[]
  ledger_run_id: number | null; triggered_by: string; forced: boolean; error: string | null
  queued_at: Date; started_at: Date | null; finished_at: Date | null
}

interface NRow {
  notice_id: number; preflight_id: number; team_id: number; mail_key: string
  status: NoticeStatus; provider: string; detail: string | null; provider_ref: string | null
  template_version: number | null; channel: DeliveryChannel; sent_at: Date | null
}

const toRun = (r: Row): PreflightRow => ({
  preflightId: Number(r.preflight_id), submissionId: Number(r.submission_id),
  teamId: Number(r.team_id), commitSha: r.commit_sha, status: r.status, verdict: r.verdict,
  checks: r.checks, skipped: r.skipped,
  ledgerRunId: r.ledger_run_id === null ? null : Number(r.ledger_run_id),
  triggeredBy: r.triggered_by, forced: r.forced, error: r.error,
  queuedAt: r.queued_at, startedAt: r.started_at, finishedAt: r.finished_at,
})

const toNotice = (r: NRow): NoticeRow => ({
  noticeId: Number(r.notice_id), preflightId: Number(r.preflight_id), teamId: Number(r.team_id),
  mailKey: r.mail_key, status: r.status, provider: r.provider, detail: r.detail,
  providerRef: r.provider_ref,
  templateVersion: r.template_version === null ? null : Number(r.template_version),
  channel: r.channel, sentAt: r.sent_at,
})

/**
 * Queue a run, or join the one already queued or running for this submission.
 *
 * The partial unique index decides: a second trigger while one is live is not a second run.
 * `joined` tells the caller which happened, so an organiser pressing the button twice is told
 * "already queued" rather than shown a run that does not exist.
 */
export async function insertQueued(input: {
  submissionId: number; teamId: number; triggeredBy: string; forced: boolean
}): Promise<{ run: PreflightRow; joined: boolean }> {
  const inserted = await queryOne<Row>(
    `INSERT INTO preflight_run (submission_id, team_id, triggered_by, forced)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (submission_id) WHERE status IN ('QUEUED', 'RUNNING') DO NOTHING
     RETURNING *`,
    [input.submissionId, input.teamId, input.triggeredBy, input.forced])
  if (inserted) return { run: toRun(inserted), joined: false }

  const live = await queryOne<Row>(
    `SELECT * FROM preflight_run
      WHERE submission_id = $1 AND status IN ('QUEUED', 'RUNNING')
      ORDER BY preflight_id DESC LIMIT 1`, [input.submissionId])
  if (!live) throw new Error('preflight insert conflicted with a run that then vanished')
  return { run: toRun(live), joined: true }
}

/** Claim up to `limit` queued runs. SKIP LOCKED, so two instances never claim the same one. */
export async function claimQueued(limit: number): Promise<PreflightRow[]> {
  if (limit <= 0) return []
  const res = await query<Row>(
    `UPDATE preflight_run SET status = 'RUNNING', started_at = now()
      WHERE preflight_id IN (
        SELECT preflight_id FROM preflight_run WHERE status = 'QUEUED'
         ORDER BY queued_at, preflight_id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit])
  return res.rows.map(toRun)
}

export async function finishPreflight(input: {
  preflightId: number; status: 'COMPLETED' | 'FAILED'; verdict: Verdict | null
  checks: CheckRecord[]; skipped: string[]; commitSha: string | null
  ledgerRunId: number | null; error: string | null
}): Promise<PreflightRow> {
  const row = await queryOne<Row>(
    `UPDATE preflight_run
        SET status = $2, verdict = $3, checks = $4::jsonb, skipped = $5, commit_sha = $6,
            ledger_run_id = $7, error = $8, finished_at = now()
      WHERE preflight_id = $1 RETURNING *`,
    [input.preflightId, input.status, input.verdict, JSON.stringify(input.checks),
     input.skipped, input.commitSha, input.ledgerRunId, input.error])
  if (!row) throw new Error(`preflight run ${input.preflightId} vanished while running`)
  return toRun(row)
}

export async function selectRun(preflightId: number): Promise<PreflightRow | null> {
  const row = await queryOne<Row>('SELECT * FROM preflight_run WHERE preflight_id = $1', [preflightId])
  return row ? toRun(row) : null
}

export async function selectLatestFor(submissionId: number): Promise<PreflightRow | null> {
  const row = await queryOne<Row>(
    `SELECT * FROM preflight_run WHERE submission_id = $1 ORDER BY preflight_id DESC LIMIT 1`,
    [submissionId])
  return row ? toRun(row) : null
}

/** The most recent COMPLETED run for this submission other than the one given. */
export async function selectPreviousCompleted(
  submissionId: number, beforeId: number,
): Promise<PreflightRow | null> {
  const row = await queryOne<Row>(
    `SELECT * FROM preflight_run
      WHERE submission_id = $1 AND preflight_id < $2 AND status = 'COMPLETED'
      ORDER BY preflight_id DESC LIMIT 1`, [submissionId, beforeId])
  return row ? toRun(row) : null
}

/** Runs still RUNNING after the timeout: the process that claimed them is gone. */
export async function selectStaleRunning(timeoutMinutes: number): Promise<PreflightRow[]> {
  const res = await query<Row>(
    `SELECT * FROM preflight_run
      WHERE status = 'RUNNING' AND started_at < now() - ($1 || ' minutes')::interval
      ORDER BY started_at`, [String(timeoutMinutes)])
  return res.rows.map(toRun)
}

export async function countLive(): Promise<{ queued: number; running: number }> {
  const row = await queryOne<{ queued: number; running: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'QUEUED')::int  AS queued,
            COUNT(*) FILTER (WHERE status = 'RUNNING')::int AS running
       FROM preflight_run`)
  return row ?? { queued: 0, running: 0 }
}

export async function insertNotice(input: {
  preflightId: number; teamId: number; mailKey: string; status: NoticeStatus; provider: string
  detail: string | null; providerRef: string | null; templateVersion: number | null
  channel?: DeliveryChannel
}): Promise<NoticeRow> {
  const row = await queryOne<NRow>(
    `INSERT INTO preflight_notice
       (preflight_id, team_id, mail_key, status, provider, detail, provider_ref,
        template_version, channel, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $4 = 'SENT' THEN now() END)
     ON CONFLICT (preflight_id) DO UPDATE SET
       status = EXCLUDED.status, provider = EXCLUDED.provider, detail = EXCLUDED.detail,
       provider_ref = EXCLUDED.provider_ref, template_version = EXCLUDED.template_version,
       channel = EXCLUDED.channel,
       sent_at = CASE WHEN EXCLUDED.status = 'SENT' THEN now() END
     RETURNING *`,
    [input.preflightId, input.teamId, input.mailKey, input.status, input.provider,
     input.detail, input.providerRef, input.templateVersion, input.channel ?? 'email'])
  if (!row) throw new Error('insertNotice returned no row')
  return toNotice(row)
}

export async function selectNotice(preflightId: number): Promise<NoticeRow | null> {
  const row = await queryOne<NRow>('SELECT * FROM preflight_notice WHERE preflight_id = $1', [preflightId])
  return row ? toNotice(row) : null
}
