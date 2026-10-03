/** Reminders sent to teams (P1.2, E50). One row per message, never the message itself. */
import { query } from '../../../db/pool.js'
import type { DeliveryChannel } from '../../../lib/ports/mailPort.js'

export interface ReminderRow {
  reminderId: number
  teamId: number
  kind: 'NOT_SUBMITTED' | 'PROBLEMS'
  status: 'SENT' | 'PREPARED' | 'FAILED'
  channel: DeliveryChannel
  provider: string
  detail: string | null
  providerRef: string | null
  sentBy: string
  sentAt: Date
}

interface Row {
  reminder_id: number; team_id: number; kind: ReminderRow['kind']; status: ReminderRow['status']
  channel: ReminderRow['channel']; provider: string; detail: string | null
  provider_ref: string | null; sent_by: string; sent_at: Date
}

const toRow = (r: Row): ReminderRow => ({
  reminderId: Number(r.reminder_id), teamId: Number(r.team_id), kind: r.kind, status: r.status,
  channel: r.channel, provider: r.provider, detail: r.detail, providerRef: r.provider_ref,
  sentBy: r.sent_by, sentAt: r.sent_at,
})

export async function insertReminder(input: Omit<ReminderRow, 'reminderId' | 'sentAt'>): Promise<ReminderRow> {
  const res = await query<Row>(
    `INSERT INTO team_reminder (team_id, kind, status, channel, provider, detail, provider_ref, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.teamId, input.kind, input.status, input.channel, input.provider, input.detail,
     input.providerRef, input.sentBy])
  return toRow(res.rows[0]!)
}

/** The latest reminder per team, for the panel. */
export async function latestReminders(): Promise<Map<number, ReminderRow>> {
  const res = await query<Row>(
    `SELECT DISTINCT ON (team_id) * FROM team_reminder ORDER BY team_id, sent_at DESC`)
  return new Map(res.rows.map((r) => [Number(r.team_id), toRow(r)]))
}
