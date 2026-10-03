/**
 * Delivery records (P1.2). Never holds a token or an address — see migration 071.
 */
import { query, queryOne } from '../../../db/pool.js'
import type { DeliveryChannel } from '../../../lib/ports/mailPort.js'

export interface DeliveryRow {
  deliveryId: number
  teamId: number
  tokenId: number
  status: 'PREPARED' | 'SENT' | 'FAILED'
  provider: string
  attempts: number
  lastError: string | null
  providerRef: string | null
  /** Which mail_template version produced the message. Null before versioning. */
  templateVersion: number | null
  /** What carried it (E49): 'discord' or 'email' — email after a refused DM is recorded as email. */
  channel: DeliveryChannel
  preparedAt: Date
  sentAt: Date | null
}

interface Row {
  delivery_id: number; team_id: number; token_id: number
  status: DeliveryRow['status']; provider: string; attempts: number
  last_error: string | null; provider_ref: string | null; template_version: number | null
  channel: DeliveryChannel; prepared_at: Date; sent_at: Date | null
}

const COLS = `delivery_id, team_id, token_id, status, provider, attempts, last_error,
              provider_ref, template_version, channel, prepared_at, sent_at`

const toDelivery = (r: Row): DeliveryRow => ({
  deliveryId: Number(r.delivery_id), teamId: Number(r.team_id), tokenId: Number(r.token_id),
  status: r.status, provider: r.provider, attempts: Number(r.attempts),
  lastError: r.last_error, providerRef: r.provider_ref,
  templateVersion: r.template_version === null ? null : Number(r.template_version),
  channel: r.channel, preparedAt: r.prepared_at, sentAt: r.sent_at,
})

/**
 * Record one attempt, or add to the one already recorded for this token.
 *
 * `attempts` accumulates rather than a second row appearing: two rows would each read like the
 * whole story of that token, and neither would be.
 */
export async function upsertDelivery(input: {
  teamId: number
  tokenId: number
  status: DeliveryRow['status']
  provider: string
  lastError: string | null
  providerRef?: string | null
  templateVersion?: number | null
  channel?: DeliveryChannel
  preparedBy: string
}): Promise<DeliveryRow> {
  const row = await queryOne<Row>(
    `INSERT INTO token_delivery
       (team_id, token_id, status, provider, last_error, provider_ref, template_version,
        channel, prepared_by, sent_at)
     VALUES ($1,$2,$3,$4,$5,$7,$8,$9,$6, CASE WHEN $3 = 'SENT' THEN now() END)
     ON CONFLICT (token_id) DO UPDATE SET
       status       = EXCLUDED.status,
       provider     = EXCLUDED.provider,
       last_error   = EXCLUDED.last_error,
       provider_ref = EXCLUDED.provider_ref,
       template_version = EXCLUDED.template_version,
       channel      = EXCLUDED.channel,
       attempts     = token_delivery.attempts + 1,
       prepared_at  = now(),
       prepared_by  = EXCLUDED.prepared_by,
       sent_at      = CASE WHEN EXCLUDED.status = 'SENT' THEN now() END
     RETURNING ${COLS}`,
    [input.teamId, input.tokenId, input.status, input.provider, input.lastError,
     input.preparedBy, input.providerRef ?? null, input.templateVersion ?? null,
     input.channel ?? 'email'])
  if (!row) throw new Error('upsertDelivery returned no row')
  return toDelivery(row)
}

/** Every delivery, newest first. Small by construction: one row per issued token. */
export async function listDeliveries(): Promise<DeliveryRow[]> {
  const res = await query<Row>(
    `SELECT ${COLS} FROM token_delivery ORDER BY prepared_at DESC`)
  return res.rows.map(toDelivery)
}
