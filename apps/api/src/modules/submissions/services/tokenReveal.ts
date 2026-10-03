/**
 * Revealing a team's current code to an admin, and purging what makes that possible
 * (E47-S02, ADR 0005).
 *
 * The order inside `revealSubmissionToken` is the control: the audit event is written BEFORE
 * the plaintext is opened, so a reveal that then fails — or a process that dies between the two
 * — still leaves "who asked, for which team, when" on record. Nothing here logs the plaintext;
 * the response is the one place it exists.
 */
import { query, queryOne } from '../../../db/pool.js'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { openToken } from '../../../lib/tokenCipher.js'
import { isEnabled } from '../../platform/services/configService.js'

const log = createLogger('submissions', 'tokenReveal')

export type RevealOutcome =
  | { available: true; tokenId: number; teamId: number; teamName: string; token: string; revealedAt: Date }
  | { available: false; tokenId: number; teamId: number | null; teamName: string | null; reason: string }

export async function revealSubmissionToken(tokenId: number, actor: string): Promise<RevealOutcome> {
  const row = await queryOne<{
    token_id: number; team_id: number | null; display_name: string | null
    token_cipher: string | null; cipher_key_id: string | null
    revoked_at: Date | null; cipher_purged_at: Date | null
  }>(
    `SELECT a.token_id, a.team_id, t.display_name, a.token_cipher, a.cipher_key_id,
            a.revoked_at, a.cipher_purged_at
       FROM access_token a LEFT JOIN team t ON t.team_id = a.team_id
      WHERE a.token_id = $1 AND a.kind = 'SUBMISSION'`, [tokenId])
  if (!row) throw new AppError('NOT_FOUND', `Submission token ${tokenId} was not found.`)

  const base = {
    tokenId: Number(row.token_id),
    teamId: row.team_id === null ? null : Number(row.team_id),
    teamName: row.display_name,
  }
  const unavailable = (reason: string): RevealOutcome => ({ available: false, ...base, reason })

  if (!(await isEnabled('feature.submissions.token_reveal'))) {
    return unavailable('Reveal is switched off (feature.submissions.token_reveal).')
  }
  if (row.revoked_at !== null) {
    return unavailable('This code was revoked, so there is nothing to reveal. Replace it instead.')
  }
  if (row.token_cipher === null || row.cipher_key_id === null) {
    return unavailable(row.cipher_purged_at !== null
      ? 'This code\'s stored copy was purged when the intake window locked.'
      : 'This code was issued without a reveal key configured, so no copy of it exists. Replace it instead.')
  }
  if (base.teamId === null || base.teamName === null) {
    return unavailable('This code is bound to no team and will be refused at submission; replace it.')
  }

  // On record first (ADR 0005 §3). Actor, team, token, time — never the code.
  const revealedAt = new Date()
  await recordAudit({
    actor, action: 'submissions.token_revealed', subjectType: 'access_token',
    subjectId: String(base.tokenId),
    payload: { teamId: base.teamId, teamName: base.teamName, revealedAt: revealedAt.toISOString() },
  })
  log.info('submission token revealed', { tokenId: base.tokenId, teamId: base.teamId, actor })

  const opened = openToken({ cipher: row.token_cipher, keyId: row.cipher_key_id }, `token:${base.tokenId}`)
  if (!opened.available) return unavailable(opened.reason)
  return {
    available: true, tokenId: base.tokenId, teamId: base.teamId, teamName: base.teamName,
    token: opened.plaintext, revealedAt,
  }
}

/**
 * Delete every stored copy (ADR 0005 §4). Called when the window locks; after that there is
 * nothing to reveal and nothing to steal. Audited with the count, so an empty column is a
 * recorded act and not an accident.
 */
export async function purgeTokenCiphers(input: { reason: string; actor: string }): Promise<{ purged: number }> {
  const res = await query(
    `UPDATE access_token SET token_cipher = NULL, cipher_purged_at = now()
      WHERE token_cipher IS NOT NULL`)
  const purged = res.rowCount ?? 0
  await recordAudit({
    actor: input.actor, action: 'submissions.token_ciphers_purged', subjectType: 'access_token',
    subjectId: 'all', payload: { purged, reason: input.reason },
  })
  log.info('stored token copies purged', { purged, reason: input.reason })
  return { purged }
}
