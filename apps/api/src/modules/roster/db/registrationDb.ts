/** Registration links (P1.2). Never the draft team, never the token in the clear — see 080. */
import { query, queryOne, type DbClient } from '../../../db/pool.js'

export interface RegistrationLink {
  linkId: number
  participantId: number
  expiresAt: Date
  usedAt: Date | null
  supersededAt: Date | null
  teamId: number | null
}

interface Row {
  link_id: number; participant_id: number; expires_at: Date; used_at: Date | null
  superseded_at: Date | null; team_id: number | null
}

const COLS = 'link_id, participant_id, expires_at, used_at, superseded_at, team_id'

const toLink = (r: Row): RegistrationLink => ({
  linkId: Number(r.link_id), participantId: Number(r.participant_id), expiresAt: r.expires_at,
  usedAt: r.used_at, supersededAt: r.superseded_at,
  teamId: r.team_id === null ? null : Number(r.team_id),
})

/** Starting again invalidates every live link this participant holds (E44-S01 acceptance 6). */
export async function supersedeLiveLinks(participantId: number, client?: DbClient): Promise<number> {
  const res = await query(
    `UPDATE registration_link SET superseded_at = now()
      WHERE participant_id = $1 AND used_at IS NULL AND superseded_at IS NULL`,
    [participantId], client)
  return res.rowCount ?? 0
}

export async function insertLink(input: {
  participantId: number; tokenHash: string; expiresAt: Date
}, client?: DbClient): Promise<RegistrationLink> {
  const row = await queryOne<Row>(
    `INSERT INTO registration_link (participant_id, token_hash, expires_at)
     VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [input.participantId, input.tokenHash, input.expiresAt], client)
  if (!row) throw new Error('insertLink returned no row')
  return toLink(row)
}

export async function selectLinkByHash(tokenHash: string): Promise<RegistrationLink | null> {
  const row = await queryOne<Row>(
    `SELECT ${COLS} FROM registration_link WHERE token_hash = $1`, [tokenHash])
  return row ? toLink(row) : null
}

/**
 * Consume the link, inside the confirming transaction.
 *
 * `WHERE used_at IS NULL` makes this the single-use guarantee under concurrency: two confirms
 * racing on one link both reach here, and only the one whose UPDATE touches a row proceeds.
 */
export async function consumeLink(
  input: { linkId: number; teamId: number; challengeId: number | null }, client: DbClient,
): Promise<boolean> {
  const res = await query(
    `UPDATE registration_link SET used_at = now(), team_id = $2, challenge_id = $3
      WHERE link_id = $1 AND used_at IS NULL AND superseded_at IS NULL`,
    [input.linkId, input.teamId, input.challengeId], client)
  return (res.rowCount ?? 0) === 1
}

