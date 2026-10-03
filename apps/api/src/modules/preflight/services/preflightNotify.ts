/**
 * Telling the team, either way (E46-S03).
 *
 * One message per completed run, chosen by verdict; a repeat of an identical outcome is
 * recorded as UNCHANGED and not sent. Every attempt writes a `preflight_notice` row, so a team
 * nobody told is visible on the intake screen rather than a silent gap (acceptance 5) — the
 * `token_delivery` pattern, reused.
 *
 * The message carries no score and no judgement (acceptance 2). It is composed from the check
 * records' team-facing text; the organiser-only detail never reaches it.
 */
import { createLogger } from '../../../lib/logger.js'
import { redactString } from '../../../lib/redact.js'
import { mail } from '../../../lib/ports/mailPort.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { queryOne } from '../../../db/pool.js'
import { isEnabled } from '../../platform/services/configService.js'
import { renderMail } from '../../submissions/services/mailTemplates.js'
import {
  insertNotice, selectPreviousCompleted, type NoticeRow, type PreflightRow,
} from '../db/preflightDb.js'
import { MAIL_KEYS, findingsText, sameOutcome } from './preflightVerdict.js'

const log = createLogger('preflight', 'notify')

/** Who to write to, read through the owning modules' published views (P1.3). */
async function addressee(run: PreflightRow): Promise<{
  teamName: string; contactEmail: string; discordUserId: string | null; challengeName: string
}> {
  const row = await queryOne<{
    team_display_name: string; contact_email: string; contact_discord_user_id: string | null; name: string
  }>(
    `SELECT s.team_display_name, t.contact_email, t.contact_discord_user_id, c.name
       FROM v_submissions_submission s
       JOIN v_submissions_team t ON t.team_id = s.team_id
       JOIN v_challenges_challenge c ON c.challenge_id = s.challenge_id
      WHERE s.submission_id = $1`, [run.submissionId])
  if (!row) {
    // Superseded by a later version while the checks ran. The run stands; the newer entry has
    // its own run and its own notice.
    throw new Error(`Submission ${run.submissionId} is no longer current, so there is nobody to tell.`)
  }
  return {
    teamName: row.team_display_name, contactEmail: row.contact_email,
    discordUserId: row.contact_discord_user_id, challengeName: row.name,
  }
}

export async function notifyTeam(run: PreflightRow): Promise<NoticeRow> {
  const provider = mail()
  const verdict = run.verdict ?? 'UNKNOWN'
  const mailKey = MAIL_KEYS[verdict]
  const base = { preflightId: run.preflightId, teamId: run.teamId, mailKey, provider: provider.name }

  if (!(await isEnabled('feature.preflight.notify'))) {
    return insertNotice({
      ...base, status: 'FAILED', providerRef: null, templateVersion: null,
      detail: 'Notification is switched off (feature.preflight.notify), so the team was not told.',
    })
  }

  const previous = await selectPreviousCompleted(run.submissionId, run.preflightId)
  if (previous && sameOutcome(previous, run)) {
    return insertNotice({
      ...base, status: 'UNCHANGED', providerRef: null, templateVersion: null,
      detail: `Same commit, verdict and findings as run ${previous.preflightId}, which was already reported.`,
    })
  }

  let to: Awaited<ReturnType<typeof addressee>>
  try {
    to = await addressee(run)
  } catch (err) {
    return insertNotice({
      ...base, status: 'FAILED', providerRef: null, templateVersion: null,
      detail: err instanceof Error ? err.message : 'The team could not be identified.',
    })
  }

  if (to.contactEmail.trim() === '' && to.discordUserId === null) {
    // Recorded as a failure to notify, not skipped (acceptance 6): an organiser-made entry with
    // no address is exactly the team that never hears.
    return insertNotice({
      ...base, status: 'FAILED', providerRef: null, templateVersion: null,
      detail: 'No contact address on this team, so nothing could be sent. Add one on the roster '
        + 'and re-run the checks.',
    })
  }

  const rendered = await renderMail(mailKey, {
    team_name: to.teamName, challenge_name: to.challengeName,
    commit: run.commitSha ?? 'unknown', findings: findingsText(run.checks),
  })

  try {
    const result = await provider.send({
      to: to.contactEmail, discordUserId: to.discordUserId,
      subject: rendered.subject, body: rendered.body,
      idempotencyKey: `preflight/${run.preflightId}`,
    })
    const notice = await insertNotice({
      ...base, status: result.delivered ? 'SENT' : 'PREPARED', detail: result.detail,
      providerRef: result.providerRef ?? null, templateVersion: rendered.templateVersion,
      channel: result.channel ?? 'email',
    })
    await recordAudit({
      actor: 'system', action: 'preflight.team_notified', subjectType: 'submission',
      subjectId: String(run.submissionId),
      payload: { preflightId: run.preflightId, verdict, status: notice.status, mailKey },
    })
    return notice
  } catch (err) {
    // Redacted: a provider's error text routinely quotes what it was handed (P8.3).
    const detail = redactString(err instanceof Error ? err.message : 'The message could not be sent.')
    log.warn('pre-flight notice could not be sent', { preflightId: run.preflightId, detail })
    return insertNotice({
      ...base, status: 'FAILED', detail, providerRef: null,
      templateVersion: rendered.templateVersion,
    })
  }
}
