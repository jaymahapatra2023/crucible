/**
 * Submission tokens (P8.2, E03-S01).
 *
 * Teams are not Crucible users. Issuing fifty accounts for one evening is all risk and no
 * benefit, so a team proves itself with a scoped, revocable token instead.
 *
 * The token is shown once at issue and only its SHA-256 is stored: a leaked database should not
 * hand an attacker the ability to submit as any team (P8.3).
 */
import { createHash, randomBytes } from 'node:crypto'
import { query, queryOne, tx, type DbClient } from '../../../db/pool.js'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { insertTeam, selectTeam } from '../db/teamDb.js'
import { sealToken } from '../../../lib/tokenCipher.js'

const log = createLogger('submissions', 'tokens')

const PREFIX = 'crs_'

export interface IssuedToken {
  tokenId: number
  label: string
  /** The only time the plaintext exists. Not recoverable afterwards. */
  token: string
  expiresAt: Date | null
  /** The team this token IS. Identity travels with the credential (E17-S01 acceptance 2). */
  teamId: number
  teamName: string
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * Issue a token, and with it the identity it carries (E17-S01 acceptance 2).
 *
 * `teamId` reissues for a team that already exists — after a revocation, or a second token for
 * a team entering a second challenge. Without it a new team is created from `label`, which is
 * what issuing a token for a team nobody has heard of means.
 *
 * The two happen in one transaction. A team created here whose token then failed to insert
 * would be a team nobody could ever submit as, sitting in the list looking real.
 *
 * `client` joins a caller's transaction instead of opening one, so a bulk issue (E20) is all or
 * nothing across the whole file rather than per team. Without it, twenty teams created and the
 * twenty-first failing would leave twenty plaintexts that were never returned to anybody.
 */
export async function issueSubmissionToken(input: {
  label: string
  teamId?: number
  contactEmail?: string
  expiresAt?: Date | null
  issuedBy: string
  client?: DbClient
}): Promise<IssuedToken> {
  const token = `${PREFIX}${randomBytes(24).toString('base64url')}`

  const issued = await tx(async (client) => {
    const team = input.teamId !== undefined
      ? await selectTeam(input.teamId, client)
      : await insertTeam({
        displayName: input.label.trim(),
        contactEmail: requireContact(input.contactEmail),
        origin: 'TOKEN',
        createdBy: input.issuedBy,
      }, client)

    if (!team) throw new AppError('NOT_FOUND', `Team ${input.teamId} was not found.`)

    // The label is how the token reads in the audit trail, and a label that disagreed with the
    // team it belongs to is exactly the discrepancy this epic exists to remove.
    const label = team.displayName

    const row = await queryOne<{ token_id: number; expires_at: Date | null }>(
      `INSERT INTO access_token
         (token_hash, kind, label, scopes, issued_by, expires_at, team_id)
       VALUES ($1, 'SUBMISSION', $2, ARRAY['submissions:create'], $3, $4, $5)
       RETURNING token_id, expires_at`,
      [hash(token), label, input.issuedBy, input.expiresAt ?? null, team.teamId], client)
    if (!row) throw new Error('issueSubmissionToken returned no row')

    // Sealed for admin reveal (ADR 0005), bound to this row's id. The ONE place a token is
    // inserted, so bulk issue, registration and reissue all seal without knowing it. Null when
    // this deployment holds no reveal key — and then nothing else here is different.
    const sealed = sealToken(token, `token:${row.token_id}`)
    if (sealed) {
      await query(
        'UPDATE access_token SET token_cipher = $2, cipher_key_id = $3 WHERE token_id = $1',
        [row.token_id, sealed.cipher, sealed.keyId], client)
    }

    return {
      tokenId: Number(row.token_id), label, token, expiresAt: row.expires_at,
      teamId: team.teamId, teamName: team.displayName,
    }
  }, input.client)

  await recordAudit({
    actor: input.issuedBy, action: 'submissions.token_issued', subjectType: 'access_token',
    subjectId: String(issued.tokenId),
    payload: { label: issued.label, teamId: issued.teamId },
  })
  log.info('submission token issued', {
    tokenId: issued.tokenId, label: issued.label, teamId: issued.teamId,
  })

  return issued
}

/**
 * Replace a team's code (E47-S01, option (a) of II.4).
 *
 * The previous live tokens are revoked and a new one issued in ONE transaction, and the new
 * plaintext is returned for the single moment it exists — exactly as issuing does. Nothing is
 * stored recoverably: `access_token` keeps only the hash, so "show me the code again" is
 * answered by handing over a new one and saying the old one has stopped working.
 */
export async function reissueSubmissionToken(input: {
  teamId: number
  reason: string
  actor: string
}): Promise<IssuedToken & { revokedTokenIds: number[] }> {
  const reason = input.reason.trim()
  if (reason.length < 3) {
    throw new AppError('VALIDATION_FAILED',
      'Say why the code is being replaced — it is written to the audit trail beside the revocation.')
  }

  const result = await tx(async (client) => {
    const revoked = await query<{ token_id: number }>(
      `UPDATE access_token
          SET revoked_at = now(), token_cipher = NULL,
              cipher_purged_at = CASE WHEN token_cipher IS NULL THEN cipher_purged_at ELSE now() END
        WHERE team_id = $1 AND kind = 'SUBMISSION' AND revoked_at IS NULL
        RETURNING token_id`, [input.teamId], client)
    const issued = await issueSubmissionToken({
      label: '', teamId: input.teamId, issuedBy: input.actor, client,
    })
    return { ...issued, revokedTokenIds: revoked.rows.map((r) => Number(r.token_id)) }
  })

  await recordAudit({
    actor: input.actor, action: 'submissions.token_reissued', subjectType: 'team',
    subjectId: String(input.teamId),
    payload: { reason, revokedTokenIds: result.revokedTokenIds, newTokenId: result.tokenId },
  })
  log.info('submission token reissued', {
    teamId: input.teamId, revoked: result.revokedTokenIds.length, newTokenId: result.tokenId,
  })
  return result
}

function requireContact(email: string | undefined): string {
  const contact = email?.trim() ?? ''
  if (contact === '') {
    throw new AppError(
      'VALIDATION_FAILED',
      'A contact email is required to issue a token for a new team: it is how the team is '
        + 'reached when their repository will not clone, and there is no account to fall back on.',
    )
  }
  return contact
}

export interface TokenIdentity {
  tokenId: number
  label: string
  /** Who the bearer IS. The submission takes its team from here, not from typed text. */
  teamId: number
  teamName: string
}

/**
 * Verify a presented token.
 *
 * Revocation is checked on every call with no caching: P8.2 requires revocation to take effect
 * immediately, and a cache window is exactly the thing that would prevent it.
 */
export async function verifySubmissionToken(presented: string): Promise<TokenIdentity> {
  if (!presented.startsWith(PREFIX)) {
    throw new AppError('UNAUTHENTICATED', 'That is not a valid submission token.')
  }

  const row = await queryOne<{
    token_id: number; label: string; expires_at: Date | null; revoked_at: Date | null
    team_id: number | null; display_name: string | null
  }>(
    `SELECT a.token_id, a.label, a.expires_at, a.revoked_at, a.team_id, t.display_name
       FROM access_token a
       LEFT JOIN team t ON t.team_id = a.team_id
      WHERE a.token_hash = $1 AND a.kind = 'SUBMISSION'`,
    [hash(presented)])

  if (!row || row.revoked_at) {
    throw new AppError('UNAUTHENTICATED', 'That submission token is not valid or has been revoked.')
  }
  if (row.expires_at && row.expires_at < new Date()) {
    throw new AppError('UNAUTHENTICATED', 'That submission token has expired.')
  }
  // Only a token issued before team identity existed, whose label matched two teams, can reach
  // here. Refused rather than guessed at: a submission attributed to the wrong team is worse
  // than one that had to wait for a reissue.
  if (row.team_id === null || row.display_name === null) {
    throw new AppError(
      'UNAUTHENTICATED',
      'That submission token is not bound to a team, so an entry made with it could not be '
        + 'attributed. Ask your organiser to issue a replacement.',
    )
  }

  await query('UPDATE access_token SET last_used_at = now() WHERE token_id = $1', [row.token_id])
  return {
    tokenId: Number(row.token_id), label: row.label,
    teamId: Number(row.team_id), teamName: row.display_name,
  }
}

export async function revokeSubmissionToken(tokenId: number, actor: string): Promise<void> {
  // The ciphertext goes with the revocation: a code that no longer works has nothing to reveal.
  const res = await query(
    `UPDATE access_token
        SET revoked_at = now(), token_cipher = NULL,
            cipher_purged_at = CASE WHEN token_cipher IS NULL THEN cipher_purged_at ELSE now() END
      WHERE token_id = $1 AND kind = 'SUBMISSION' AND revoked_at IS NULL`,
    [tokenId])
  if (res.rowCount === 0) {
    throw new AppError('NOT_FOUND', `Submission token ${tokenId} was not found, or is already revoked.`)
  }
  await recordAudit({
    actor, action: 'submissions.token_revoked', subjectType: 'access_token',
    subjectId: String(tokenId), payload: {},
  })
}

/**
 * How a token list may be ordered (E40).
 *
 * An allow-list, never a column from the request. `used` puts never-used tokens FIRST rather
 * than last: an unused token before a deadline usually means the code never reached the team,
 * which is the one thing on this screen worth chasing.
 */
const TOKEN_SORTS: Record<string, string> = {
  issued: 'a.issued_at DESC',
  team: 'lower(COALESCE(t.display_name, a.label)) ASC',
  used: 'a.last_used_at ASC NULLS FIRST',
}

export const TOKEN_SORTS_KEYS = Object.keys(TOKEN_SORTS)

export async function listSubmissionTokens(sort?: string): Promise<Array<{
  tokenId: number; label: string; issuedAt: Date; expiresAt: Date | null
  revokedAt: Date | null; lastUsedAt: Date | null
  teamId: number | null; teamName: string | null
  /** Whether an admin could reveal it: sealed, and not revoked (ADR 0005). */
  revealable: boolean
}>> {
  const res = await query<{
    token_id: number; label: string; issued_at: Date; expires_at: Date | null
    revoked_at: Date | null; last_used_at: Date | null
    team_id: number | null; display_name: string | null; revealable: boolean
  }>(
    `SELECT a.token_id, a.label, a.issued_at, a.expires_at, a.revoked_at, a.last_used_at,
            a.team_id, t.display_name,
            (a.token_cipher IS NOT NULL AND a.revoked_at IS NULL) AS revealable
       FROM access_token a
       LEFT JOIN team t ON t.team_id = a.team_id
      WHERE a.kind = 'SUBMISSION'
      ORDER BY ${TOKEN_SORTS[sort ?? ''] ?? TOKEN_SORTS['issued']}, a.token_id DESC
      LIMIT 200`)
  return res.rows.map((r) => ({
    tokenId: Number(r.token_id), label: r.label, issuedAt: r.issued_at,
    expiresAt: r.expires_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at,
    // Null only for a token issued before identity existed that could not be resolved. The
    // organiser surface shows it as unbound rather than hiding it, because it will fail at the
    // worst possible moment otherwise.
    teamId: r.team_id === null ? null : Number(r.team_id),
    teamName: r.display_name,
    revealable: r.revealable,
  }))
}
