/**
 * Chasing the teams that are not there yet (E50).
 *
 * Two kinds of team an organiser needs to see before the deadline, not after it: one that
 * registered and has not submitted, and one whose entry the pre-flight found problems with that
 * it has not fixed. Both are listed with the last reminder they were sent, and reminded by an
 * organiser's act — recorded per team, Discord first with email as the fallback, never twice by
 * accident (the list says when the last one went).
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { redactString } from '../../../lib/redact.js'
import { mail } from '../../../lib/ports/mailPort.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { query } from '../../../db/pool.js'
import { getString } from '../../platform/services/configService.js'
import { renderMail } from './mailTemplates.js'
import { deadlineWording } from './windowService.js'
import { listTeams } from '../db/teamDb.js'
import { insertReminder, latestReminders, type ReminderRow } from '../db/reminderDb.js'

const log = createLogger('submissions', 'reminders')

export interface TeamToChase {
  teamId: number
  teamName: string
  contactEmail: string
  hasDiscord: boolean
  kind: 'NOT_SUBMITTED' | 'PROBLEMS'
  /** What is wrong, for the panel and the message. */
  situation: string
  lastReminder: ReminderRow | null
}

/** Entries whose latest pre-flight found problems, read through the published view (P1.3). */
async function problemTeams(): Promise<Map<number, string>> {
  const res = await query<{ team_id: number; checks: Array<{ label: string; status: string }> }>(
    `SELECT team_id, checks FROM v_preflight_latest WHERE status = 'COMPLETED' AND verdict = 'PROBLEMS'`)
  return new Map(res.rows.map((r) => [
    Number(r.team_id),
    r.checks.filter((c) => c.status === 'FAIL').map((c) => c.label).join(', '),
  ]))
}

export async function chaseList(): Promise<TeamToChase[]> {
  const [teams, problems, reminders] = await Promise.all([listTeams(), problemTeams(), latestReminders()])
  const out: TeamToChase[] = []
  for (const t of teams) {
    const base = {
      teamId: t.teamId, teamName: t.displayName, contactEmail: t.contactEmail,
      hasDiscord: t.contactDiscordUserId !== null, lastReminder: reminders.get(t.teamId) ?? null,
    }
    if (t.currentSubmissions === 0) {
      // A team with no working code cannot submit; that is the token panel's problem, not this
      // list's — but it is still a team that has not submitted, and the panel says both.
      out.push({ ...base, kind: 'NOT_SUBMITTED', situation: t.activeTokens === 0
        ? 'Has not submitted, and holds no working submission code.'
        : 'Has not submitted.' })
    } else if (problems.has(t.teamId)) {
      out.push({ ...base, kind: 'PROBLEMS', situation: `Entry has problems: ${problems.get(t.teamId)}.` })
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.teamName.localeCompare(b.teamName))
}

export async function sendReminders(input: { teamIds?: readonly number[]; actor: string }): Promise<ReminderRow[]> {
  const list = await chaseList()
  const wanted = input.teamIds === undefined ? list : list.filter((t) => input.teamIds!.includes(t.teamId))
  if (wanted.length === 0) {
    throw new AppError('PRECONDITION_FAILED', 'Nobody to remind: every team has submitted and nothing is outstanding.')
  }
  const wording = {
    closesAt: await deadlineWording(),
    submitUrl: (await getString('event.submit_url')).trim() || 'the submission page',
  }

  const sent: ReminderRow[] = []
  for (const team of wanted) sent.push(await sendOne(team, wording, input.actor))

  await recordAudit({
    actor: input.actor, action: 'submissions.teams_reminded', subjectType: 'team', subjectId: 'bulk',
    payload: {
      teams: sent.map((s) => s.teamId), sent: sent.filter((s) => s.status === 'SENT').length,
      failed: sent.filter((s) => s.status === 'FAILED').length,
    },
  })
  return sent
}

async function sendOne(
  team: TeamToChase, wording: { closesAt: string; submitUrl: string }, actor: string,
): Promise<ReminderRow> {
  const provider = mail()
  const base = { teamId: team.teamId, kind: team.kind, provider: provider.name, sentBy: actor }
  if (team.contactEmail.trim() === '' && !team.hasDiscord) {
    return insertReminder({ ...base, status: 'FAILED', channel: 'email', providerRef: null,
      detail: 'No contact address and no Discord on this team, so nothing could be sent.' })
  }
  try {
    const rendered = await renderMail('mail.submission_reminder', {
      team_name: team.teamName, closes_at: wording.closesAt, submit_url: wording.submitUrl,
      situation_short: team.kind === 'NOT_SUBMITTED' ? 'you have not submitted yet' : 'your entry needs attention',
      situation: team.kind === 'NOT_SUBMITTED'
        ? 'We have no entry from your team yet.'
        : `Our checks found problems with your entry that have not been fixed: ${team.situation.replace(/^Entry has problems: /, '')}`,
    })
    const result = await provider.send({
      to: team.contactEmail, discordUserId: await discordFor(team.teamId),
      subject: rendered.subject, body: rendered.body,
      idempotencyKey: `reminder/${team.teamId}/${team.kind}/${Date.now()}`,
    })
    return insertReminder({ ...base, status: result.delivered ? 'SENT' : 'PREPARED',
      channel: result.channel ?? 'email', providerRef: result.providerRef ?? null,
      detail: result.fallbackReason ?? (result.delivered ? null : result.detail) })
  } catch (err) {
    const detail = redactString(err instanceof Error ? err.message : 'The message could not be sent.')
    log.warn('reminder could not be sent', { teamId: team.teamId, detail })
    return insertReminder({ ...base, status: 'FAILED', channel: 'email', providerRef: null, detail })
  }
}

async function discordFor(teamId: number): Promise<string | null> {
  const teams = await listTeams()
  return teams.find((t) => t.teamId === teamId)?.contactDiscordUserId ?? null
}
