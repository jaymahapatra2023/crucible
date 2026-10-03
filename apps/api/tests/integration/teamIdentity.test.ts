/**
 * A team is a record, and a token belongs to one (E17; G4, G13, G14).
 *
 * Team identity used to be `submission.team_name TEXT`, unique per challenge among current
 * submissions. Three things followed from that, and all three are what these tests hold shut:
 *
 *   * "Night Shift" and "The Night Shift" were different teams and neither knew it.
 *   * A team that corrected its name between versions started a second lineage.
 *   * A token was labelled with a name nothing reconciled against the form, so the audit trail
 *     could not answer whether a team submitted with their own token.
 *
 * Teams still have no account and no password. This is a record, not a login (P8.2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installFakeGit, restoreGit, withEntry } from '../support/fakeGit.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { createChallenge } from '../../src/modules/challenges/services/challengeService.js'
import {
  approveRubric, createVersion, freezeRubric, setDimensionWeights,
} from '../../src/modules/rubrics/services/rubricService.js'
import { publishRubric } from '../../src/modules/rubrics/services/rubricExport.js'
import { submit } from '../../src/modules/submissions/services/submissionService.js'
import { openWindow } from '../../src/modules/submissions/services/windowService.js'
import {
  issueSubmissionToken, listSubmissionTokens, revokeSubmissionToken, verifySubmissionToken,
} from '../../src/modules/submissions/services/submissionTokens.js'
import { getTeams, similarTeams } from '../../src/modules/submissions/services/teamService.js'
import { teamView } from '../../src/modules/submissions/services/teamEntry.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'team' }, fn)
const anchors = { 0: 'none', 1: 'named', 2: 'unused', 3: 'works', 4: 'tested' }

let challengeId: number
let otherChallengeId: number

async function publishRubricFor(id: number) {
  const rubric = await inScope(() => createVersion({
    challengeId: id,
    criteria: [{
      dimension: 'CHALLENGE_FIDELITY', name: 'Solves the challenge',
      description: 'Whether the submission solves the stated problem.', weight: 1,
      evidenceSpec: 'A reader can point to the implementing code.', anchors,
      sourceRef: 'brief §1', sortOrder: 0,
    }],
    actor: ACTOR,
  }))
  const rubricId = Number(rubric.rubricId)
  await inScope(() => setDimensionWeights(rubricId, {
    CHALLENGE_FIDELITY: 1, ENGINEERING_QUALITY: 0, PRINCIPLES_STANDARDS: 0, RUNS: 0, ORIGINALITY: 0,
  }, ACTOR))
  await inScope(() => approveRubric(rubricId, ACTOR, ['DIMENSION_WEIGHTED_BUT_EMPTY']))
  await inScope(() => freezeRubric(rubricId, ACTOR))
  await inScope(() => publishRubric(rubricId, ACTOR))
}

const issue = (label: string, contactEmail = 'team@test.local') =>
  inScope(() => issueSubmissionToken({ label, contactEmail, issuedBy: ACTOR }))

const entry = (teamId: number, overrides: Record<string, unknown> = {}) => ({
  teamId,
  contactEmail: 'alpha@team.test',
  challengeId,
  repoUrl: 'https://github.com/team-alpha/project',
  buildMethod: 'COMMAND' as const,
  buildCommand: 'npm ci',
  via: 'TEAM_TOKEN' as const,
  actor: 'token:test',
  ...overrides,
})

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installFakeGit({ '*': { files: withEntry({ 'Dockerfile': 'FROM node:22' }) } })

  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  challengeId = challenge.challengeId
  const other = await inScope(() => createChallenge({ name: 'Challenge Beta', actor: ACTOR }))
  otherChallengeId = other.challengeId

  await publishRubricFor(challengeId)
  await publishRubricFor(otherChallengeId)
  await inScope(() => openWindow({
    name: 'Event intake', opensAt: new Date(Date.now() - 3600_000),
    closesAt: new Date(Date.now() + 3600_000), actor: ACTOR,
  }))
})

afterEach(() => restoreGit())

describe('issuing a token issues an identity (E17-S01)', () => {
  it('creates the team the token belongs to', async () => {
    const issued = await issue('The Night Shift', 'night@team.test')
    expect(issued.teamId).toBeGreaterThan(0)
    expect(issued.teamName).toBe('The Night Shift')

    const teams = await getTeams()
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({
      displayName: 'The Night Shift', contactEmail: 'night@team.test', origin: 'TOKEN',
    })
  })

  it('REFUSES to create a team with no way to reach it', async () => {
    // A team has no account. The contact is the only channel there is.
    await expect(inScope(() => issueSubmissionToken({ label: 'No Contact', issuedBy: ACTOR })))
      .rejects.toThrow(/contact email is required/i)
  })

  it('reissues against the SAME team rather than making a second one', async () => {
    const first = await issue('The Night Shift', 'night@team.test')
    await inScope(() => revokeSubmissionToken(first.tokenId, ACTOR))

    const replacement = await inScope(() => issueSubmissionToken({
      label: 'ignored', teamId: first.teamId, issuedBy: ACTOR,
    }))
    expect(replacement.teamId).toBe(first.teamId)
    expect(await getTeams()).toHaveLength(1)
  })

  it('labels a reissued token with the TEAM\'s name, not whatever was typed', async () => {
    // A label that disagreed with the team it belongs to is the discrepancy this epic removes.
    const first = await issue('The Night Shift', 'night@team.test')
    const replacement = await inScope(() => issueSubmissionToken({
      label: 'something else entirely', teamId: first.teamId, issuedBy: ACTOR,
    }))
    expect(replacement.label).toBe('The Night Shift')
  })

  it('refuses to issue against a team that does not exist', async () => {
    await expect(inScope(() => issueSubmissionToken({
      label: 'Ghost', teamId: 999_999, issuedBy: ACTOR,
    }))).rejects.toThrow(/was not found/)
  })

  it('leaves no team behind when the TOKEN cannot be written', async () => {
    // One transaction. A team created here whose token then failed would be a team that can
    // never submit, sitting in the organiser's list looking real. The failure is forced rather
    // than waited for: this is about the rollback, not about any particular cause.
    await query('ALTER TABLE access_token ADD CONSTRAINT tmp_refuse_all CHECK (false) NOT VALID')
    try {
      await expect(inScope(() => issueSubmissionToken({
        label: 'Doomed', contactEmail: 'doomed@team.test', issuedBy: ACTOR,
      }))).rejects.toThrow()
      expect(await getTeams()).toHaveLength(0)
    } finally {
      await query('ALTER TABLE access_token DROP CONSTRAINT tmp_refuse_all')
    }
  })

  it('REFUSES to issue a submission token with no team, at the database', async () => {
    const issued = await issue('Bound', 'b@team.test')
    await expect(query(
      'UPDATE access_token SET team_id = NULL WHERE token_id = $1', [issued.tokenId],
    )).rejects.toThrow()
  })

  it('tells a verified token who it is', async () => {
    const issued = await issue('The Night Shift', 'night@team.test')
    const identity = await verifySubmissionToken(issued.token)
    expect(identity).toMatchObject({ teamId: issued.teamId, teamName: 'The Night Shift' })
  })

  it('REFUSES a token with no team behind it', async () => {
    // Only a token predating identity whose label matched two teams can be in this state.
    // Refused rather than guessed at: a misattributed entry is worse than a reissue.
    const issued = await asLegacyUnbound('Unbound')
    await expect(verifySubmissionToken(issued.token)).rejects.toThrow(/not bound to a team/)
  })

  it('shows an unbound token in the organiser listing rather than hiding it', async () => {
    // It will fail at submission time. Better seen here than at a team's deadline.
    await asLegacyUnbound('Unbound')
    const listed = await listSubmissionTokens()
    expect(listed[0]).toMatchObject({ teamId: null, teamName: null })
  })
})

describe('names that collide (G13)', () => {
  it('finds a team whose name differs only by a leading "the"', async () => {
    await issue('Night Shift', 'ns@team.test')
    const similar = await similarTeams('The Night Shift')
    expect(similar.map((t) => t.displayName)).toEqual(['Night Shift'])
  })

  it('finds one differing only by punctuation and case', async () => {
    await issue('Night-Shift', 'ns@team.test')
    expect(await similarTeams('night shift')).toHaveLength(1)
  })

  it('does NOT merge them — it only says they exist', async () => {
    // "Night Shift" and "The Night Shift" may genuinely be two teams. Collapsing them would be
    // inventing a fact; what was missing is that nobody could see the collision at all.
    await issue('Night Shift', 'a@team.test')
    await issue('The Night Shift', 'b@team.test')
    expect(await getTeams()).toHaveLength(2)
  })

  it('reports nothing for a name genuinely unlike the others', async () => {
    await issue('Night Shift', 'ns@team.test')
    expect(await similarTeams('Daylight Robbery')).toHaveLength(0)
  })
})

describe('a submission takes its team from its token (E17-S02)', () => {
  it('records the team, the route and the credential', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    const submission = await inScope(() => submit(entry(issued.teamId, {
      submittedTokenId: issued.tokenId,
    })))

    const row = await query<{ team_id: number; submitted_via: string; token: number }>(
      `SELECT team_id, submitted_via, submitted_token_id AS token
         FROM submission WHERE submission_id = $1`, [submission.submissionId])
    expect(row.rows[0]).toMatchObject({
      team_id: issued.teamId, submitted_via: 'TEAM_TOKEN', token: issued.tokenId,
    })
  })

  it('takes the name from the TEAM when the form says nothing', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    const submission = await inScope(() => submit(entry(issued.teamId)))
    expect(submission.teamName).toBe('Team Alpha')
  })

  it('does NOT rename the team from the form — the token is the identity (E45-S01)', async () => {
    // E17-S02 let a typed name correct the team's spelling at submit time. E45 removed the
    // field: a team that mistyped its own name renamed itself on the organiser's roster, and a
    // team that typed a teammate's name renamed THEM. A stray name in the input is ignored.
    const issued = await issue('Team Aplha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId, { teamName: 'Team Alpha' })))

    const teams = await getTeams()
    expect(teams).toHaveLength(1)
    expect(teams[0]!.displayName).toBe('Team Aplha')
    expect(teams[0]!.teamId).toBe(issued.teamId)
  })

  it('writes no rename to the audit trail, because none happened', async () => {
    const issued = await issue('Team Aplha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId, { teamName: 'Team Alpha' })))

    const audit = await query(
      `SELECT payload FROM audit_event WHERE action = 'submissions.team_renamed'`)
    expect(audit.rows).toHaveLength(0)
  })

  it('SUPERSEDES the earlier entry across a rename (acceptance 3)', async () => {
    // The defect this closes: matching on the name made a corrected spelling a second lineage,
    // so a team ended the evening with two entries and neither of them superseded.
    const issued = await issue('Team Aplha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId)))
    const second = await inScope(() => submit(entry(issued.teamId, {
      teamName: 'Team Alpha', repoUrl: 'https://github.com/team-alpha/v2',
    })))

    expect(second.version).toBe(2)
    const current = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM submission WHERE team_id = $1 AND is_current',
      [issued.teamId])
    expect(current.rows[0]!.n).toBe(1)
  })

  it('snapshots the TEAM\'s name on each version, never the form\'s', async () => {
    // A snapshot of what the team was called when the entry was made — taken from the team,
    // so a name smuggled into the input cannot falsify what the entry was made as.
    const issued = await issue('Team Aplha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId)))
    await inScope(() => submit(entry(issued.teamId, { teamName: 'Team Alpha' })))

    const names = await query<{ team_name: string }>(
      'SELECT team_name FROM submission WHERE team_id = $1 ORDER BY version', [issued.teamId])
    expect(names.rows.map((r) => r.team_name)).toEqual(['Team Aplha', 'Team Aplha'])
  })

  it('lets one team enter two challenges', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId)))
    const beta = await inScope(() => submit(entry(issued.teamId, {
      challengeId: otherChallengeId,
    })))
    expect(beta.version).toBe(1)
  })

  it('ENFORCES one current entry per team and challenge at the database (acceptance 5)', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    const first = await inScope(() => submit(entry(issued.teamId)))

    await expect(query(
      `INSERT INTO submission
         (team_id, team_name, contact_email, challenge_id, repo_url, build_method,
          build_command, validation_status)
       VALUES ($1, 'Team Alpha', 'a@team.test', $2, 'https://github.com/x/y', 'COMMAND',
               'npm ci', 'VALID')`,
      [issued.teamId, challengeId])).rejects.toThrow()

    // And the rule is on the identity, not on the string: the same name under a NEW team is fine.
    const second = await issue('Team Alpha', 'other@team.test')
    const allowed = await inScope(() => submit(entry(second.teamId)))
    expect(allowed.submissionId).not.toBe(first.submissionId)
  })

  it('records an organiser entry as an organiser entry', async () => {
    const issued = await issue('Phoned In', 'phone@team.test')
    const submission = await inScope(() => submit(entry(issued.teamId, {
      via: 'ORGANISER', actor: ACTOR, submittedTokenId: null,
    })))

    const row = await query<{ submitted_via: string; submitted_by: string }>(
      'SELECT submitted_via, submitted_by FROM submission WHERE submission_id = $1',
      [submission.submissionId])
    expect(row.rows[0]).toMatchObject({ submitted_via: 'ORGANISER', submitted_by: ACTOR })
  })
})

describe('a team seeing their own entry (E17-S03)', () => {
  it('returns their entry and the challenge it is against', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId)))

    const view = await teamView(issued.teamId)
    expect(view.team.displayName).toBe('Team Alpha')
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]).toMatchObject({ challengeName: 'Challenge Alpha', version: 1 })
  })

  it('returns ONLY that team\'s entry (acceptance 2)', async () => {
    const alpha = await issue('Team Alpha', 'alpha@team.test')
    const beta = await issue('Team Beta', 'beta@team.test')
    await inScope(() => submit(entry(alpha.teamId)))
    await inScope(() => submit(entry(beta.teamId, {
      repoUrl: 'https://github.com/team-beta/project',
    })))

    const view = await teamView(alpha.teamId)
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]!.repoUrl).toContain('team-alpha')
  })

  it('says plainly when there is no entry, rather than returning an empty list', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    const view = await teamView(issued.teamId)
    expect(view.entries).toHaveLength(0)
    expect(view.message).toMatch(/no entry recorded yet/i)
  })

  it('names what is wrong and what to do while there is still time (acceptance 3)', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    const submission = await inScope(() => submit(entry(issued.teamId)))
    await query(
      `UPDATE submission SET validation_status = 'PRIVATE',
              validation_detail = 'GitHub would not serve this repository anonymously.'
        WHERE submission_id = $1`, [submission.submissionId])

    const view = await teamView(issued.teamId)
    expect(view.entries[0]!.remedy).toMatch(/Make it public/i)
    expect(view.message).toMatch(/need your attention/i)
  })

  it('says nothing to do when there is nothing to do', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId)))
    const view = await teamView(issued.teamId)
    expect(view.entries[0]!.remedy).toBeNull()
    expect(view.message).toMatch(/Nothing to do/i)
  })

  it('tells a team when an organiser entered on their behalf', async () => {
    const issued = await issue('Phoned In', 'phone@team.test')
    await inScope(() => submit(entry(issued.teamId, {
      via: 'ORGANISER', actor: ACTOR, submittedTokenId: null,
    })))
    expect((await teamView(issued.teamId)).entries[0]!.submittedOnTheirBehalf).toBe(true)
  })

  it('shows the superseded entry not at all — only what stands now', async () => {
    const issued = await issue('Team Alpha', 'alpha@team.test')
    await inScope(() => submit(entry(issued.teamId)))
    await inScope(() => submit(entry(issued.teamId, {
      repoUrl: 'https://github.com/team-alpha/v2',
    })))

    const view = await teamView(issued.teamId)
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]!.version).toBe(2)
  })
})

/**
 * A token as it existed BEFORE identity did: issued, valid, belonging to nobody.
 *
 * The constraint added with team identity refuses this state on anything written since, so the
 * only way to reproduce it is to stand the constraint down for the length of one write — which
 * is exactly the history the row it models came from.
 */
async function asLegacyUnbound(label: string): Promise<{ tokenId: number; token: string }> {
  const issued = await issue(label, 'legacy@team.test')
  await query('ALTER TABLE access_token DROP CONSTRAINT chk_submission_token_has_team')
  try {
    await query('UPDATE access_token SET team_id = NULL WHERE token_id = $1', [issued.tokenId])
  } finally {
    await query(`ALTER TABLE access_token
                 ADD CONSTRAINT chk_submission_token_has_team
                 CHECK (kind <> 'SUBMISSION' OR team_id IS NOT NULL) NOT VALID`)
  }
  return { tokenId: issued.tokenId, token: issued.token }
}
