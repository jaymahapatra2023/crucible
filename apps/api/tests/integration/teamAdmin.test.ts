/**
 * Replacing a team's code and correcting a team (E47-S01, E48-S01).
 *
 * The properties: a replaced code stops the old one at once and stores nothing recoverable; a
 * rename that would collide is refused naming the clash; an entry keeps the name it was made
 * under whatever happens to the team afterwards.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import {
  issueSubmissionToken, reissueSubmissionToken, verifySubmissionToken,
} from '../../src/modules/submissions/services/submissionTokens.js'
import { reviseTeam } from '../../src/modules/submissions/services/teamService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'team-admin' }, fn)

const issue = (label: string, contactEmail = 'team@test.local') =>
  inScope(() => issueSubmissionToken({ label, contactEmail, issuedBy: ACTOR }))

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
})

describe('replacing a code (E47-S01, option a)', () => {
  it('revokes the old code and issues a new one for the SAME team', async () => {
    const old = await issue('Team Alpha')
    const fresh = await inScope(() => reissueSubmissionToken({
      teamId: old.teamId, reason: 'team lost it', actor: ACTOR,
    }))

    expect(fresh.teamId).toBe(old.teamId)
    expect(fresh.token).not.toBe(old.token)
    expect(fresh.revokedTokenIds).toEqual([old.tokenId])
    await expect(verifySubmissionToken(old.token)).rejects.toThrow(/not valid|revoked/i)
    expect((await verifySubmissionToken(fresh.token)).teamId).toBe(old.teamId)
  })

  it('stops EVERY live code the team held, not only the latest', async () => {
    const first = await issue('Team Alpha')
    const second = await inScope(() => issueSubmissionToken({
      label: 'Team Alpha', teamId: first.teamId, issuedBy: ACTOR,
    }))
    const fresh = await inScope(() => reissueSubmissionToken({
      teamId: first.teamId, reason: 'sent to the wrong address', actor: ACTOR,
    }))
    expect(fresh.revokedTokenIds.sort()).toEqual([first.tokenId, second.tokenId].sort())
  })

  it('writes the reason to the audit trail beside the revocation', async () => {
    const old = await issue('Team Alpha')
    await inScope(() => reissueSubmissionToken({ teamId: old.teamId, reason: 'team lost it', actor: ACTOR }))

    const audit = await query<{ actor: string; payload: { reason: string; revokedTokenIds: number[] } }>(
      `SELECT actor, payload FROM audit_event WHERE action = 'submissions.token_reissued'`)
    expect(audit.rows[0]!.actor).toBe(ACTOR)
    expect(audit.rows[0]!.payload).toMatchObject({ reason: 'team lost it', revokedTokenIds: [old.tokenId] })
  })

  it('refuses without a reason, because the revocation must be explicable later', async () => {
    const old = await issue('Team Alpha')
    await expect(inScope(() => reissueSubmissionToken({ teamId: old.teamId, reason: ' ', actor: ACTOR })))
      .rejects.toThrow(/Say why/)
    expect((await verifySubmissionToken(old.token)).teamId).toBe(old.teamId)
  })

  it('stores nothing recoverable: only hashes, before and after', async () => {
    const old = await issue('Team Alpha')
    const fresh = await inScope(() => reissueSubmissionToken({ teamId: old.teamId, reason: 'lost', actor: ACTOR }))
    const rows = await query<{ token_hash: string }>('SELECT token_hash FROM access_token')
    for (const r of rows.rows) {
      expect(r.token_hash).not.toBe(old.token)
      expect(r.token_hash).not.toBe(fresh.token)
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('correcting a team (E48-S01)', () => {
  it('renames, audited, and the entry keeps the name it was made under', async () => {
    const issued = await issue('Team Aplha')
    await query(
      `INSERT INTO submission (team_id, team_name, contact_email, challenge_id, repo_url,
                               build_method, build_command, validation_status)
       VALUES ($1, 'Team Aplha', 'team@test.local', 1, 'https://github.com/a/b', 'COMMAND', 'npm ci', 'VALID')`,
      [issued.teamId])

    const after = await inScope(() => reviseTeam({ teamId: issued.teamId, displayName: 'Team Alpha', actor: ACTOR }))
    expect(after.displayName).toBe('Team Alpha')

    const audit = await query<{ payload: { from: string; to: string } }>(
      `SELECT payload FROM audit_event WHERE action = 'submissions.team_renamed'`)
    expect(audit.rows[0]!.payload).toEqual({ from: 'Team Aplha', to: 'Team Alpha' })
    const entry = await query<{ team_name: string }>('SELECT team_name FROM submission')
    expect(entry.rows[0]!.team_name).toBe('Team Aplha')
  })

  it('refuses a name that collides with another team, naming the clash', async () => {
    await issue('The Night Shift', 'a@test.local')
    const other = await issue('Day Shift', 'b@test.local')
    await expect(inScope(() => reviseTeam({ teamId: other.teamId, displayName: 'night shift!', actor: ACTOR })))
      .rejects.toThrow(/collides with the existing team "The Night Shift"/)
  })

  it('lets a team keep its own name in a different spelling', async () => {
    const team = await issue('Night Shift')
    const after = await inScope(() => reviseTeam({ teamId: team.teamId, displayName: 'The Night Shift', actor: ACTOR }))
    expect(after.displayName).toBe('The Night Shift')
  })

  it('changes the contact, audited separately from a rename', async () => {
    const team = await issue('Team Alpha')
    await inScope(() => reviseTeam({ teamId: team.teamId, contactEmail: 'lead@test.local', actor: ACTOR }))
    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_event WHERE action LIKE 'submissions.team_%'`)
    expect(audit.rows.map((r) => r.action)).toEqual(['submissions.team_contact_changed'])
  })
})
