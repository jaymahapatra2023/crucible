/**
 * Submission intake integration tests (E03-S01 … E03-S04).
 *
 * Only `git` itself is substituted; URL validation, host allow-listing, path safety, Dockerfile
 * confirmation, versioning and the window rules all run for real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installFakeGit, restoreGit, setRepoScript, withEntry } from '../support/fakeGit.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { createChallenge } from '../../src/modules/challenges/services/challengeService.js'
import { createVersion, approveRubric, freezeRubric, setDimensionWeights } from '../../src/modules/rubrics/services/rubricService.js'
import { publishRubric } from '../../src/modules/rubrics/services/rubricExport.js'
import {
  getSubmission, getSubmissions, getValidationHistory, getIntakeHealth,
  revalidate, revalidateDue, submit,
} from '../../src/modules/submissions/services/submissionService.js'
import { intakeStatus, lockWindow, openWindow } from '../../src/modules/submissions/services/windowService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'intake' }, fn)

let challengeId: number

const anchors = { 0: 'none', 1: 'named', 2: 'unused', 3: 'works', 4: 'tested' }

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

async function openIntake() {
  const now = Date.now()
  await inScope(() => openWindow({
    name: 'Event intake',
    opensAt: new Date(now - 3600_000),
    closesAt: new Date(now + 3600_000),
    actor: ACTOR,
  }))
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  teamName: 'Team Alpha',
  contactEmail: 'alpha@team.test',
  challengeId,
  repoUrl: 'https://github.com/team-alpha/project',
  buildMethod: 'COMMAND' as const,
  buildCommand: 'npm ci && npm run build',
  actor: 'token:Team Alpha',
  ...overrides,
})

/**
 * Submit as the named team.
 *
 * Identity is a team id since E17-S02, so the fixture resolves the name to a record the way
 * token issue does — create it if it is new, reuse it if it is not. The tests below still say
 * "Team Alpha" because that is what they are about; what changed is that the name is no longer
 * what the system matches on.
 */
async function teamFor(displayName: string): Promise<number> {
  const found = await query<{ team_id: number }>(
    'SELECT team_id FROM team WHERE normalised_name = team_normalise($1)', [displayName])
  if (found.rows[0]) return Number(found.rows[0].team_id)

  const made = await query<{ team_id: number }>(
    `INSERT INTO team (display_name, contact_email, origin, created_by)
     VALUES ($1, 'team@test.local', 'ORGANISER', 'fixture') RETURNING team_id`, [displayName])
  return Number(made.rows[0]!.team_id)
}

const submitAs = async (overrides: Record<string, unknown> = {}) => {
  const input = entry(overrides)
  const teamId = await teamFor(String(input.teamName))
  return inScope(() => submit({ ...input, teamId, via: 'TEAM_TOKEN' }))
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installFakeGit({ '*': { files: withEntry({ 'Dockerfile': 'FROM node:22' }) } })

  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  challengeId = challenge.challengeId
  await publishRubricFor(challengeId)
  await openIntake()
})

afterEach(() => restoreGit())

describe('accepting a submission (E03-S01)', () => {
  it('captures everything the evaluator needs', async () => {
    const s = await submitAs()
    expect(s).toMatchObject({
      teamName: 'Team Alpha', contactEmail: 'alpha@team.test',
      challengeId, buildMethod: 'COMMAND', buildCommand: 'npm ci && npm run build',
      version: 1, isCurrent: true, validationStatus: 'VALID',
    })
  })

  it('validates at submit time, so a problem is caught on the day', async () => {
    setRepoScript('broken-team', {
      failWith: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    })
    const s = await submitAs({
      teamName: 'Broken Team', repoUrl: 'https://github.com/broken-team/project',
    })
    expect(s.validationStatus).toBe('PRIVATE')
    expect(s.validationDetail).toMatch(/either private or the URL is wrong/)
  })

  it('refuses a repository on a host that is not allow-listed', async () => {
    const s = await submitAs({ repoUrl: 'https://bitbucket.org/team/project' })
    expect(s.validationStatus).toBe('REJECTED')
    expect(s.validationDetail).toMatch(/must be hosted on/)
  })

  it('refuses a submission before a rubric has been published', async () => {
    const other = await inScope(() => createChallenge({ name: 'Unpublished', actor: ACTOR }))
    await expect(submitAs({
      challengeId: other.challengeId, teamName: 'Early Bird',
    })).rejects.toThrow(/No published rubric/)
  })

  it('records the submission in the audit trail', async () => {
    await submitAs()
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event WHERE action = 'submissions.submission_created'`)
    expect(rows.rows[0]!.n).toBe(1)
  })
})

describe('resubmission supersedes and is versioned (E03-S01 acceptance 3)', () => {
  it('keeps one CURRENT entry and versions the chain', async () => {
    const first = await submitAs()
    const second = await submitAs({
      repoUrl: 'https://github.com/team-alpha/project-v2',
    })

    expect(second.version).toBe(2)
    expect(second.isCurrent).toBe(true)

    const superseded = await getSubmission(first.submissionId)
    expect(superseded.isCurrent).toBe(false)
    expect(superseded.supersededBy).toBe(second.submissionId)
  })

  it('never destroys the earlier entry — the chain stays auditable', async () => {
    const first = await submitAs()
    await submitAs({ repoUrl: 'https://github.com/team-alpha/v2' })
    expect(await getSubmission(first.submissionId)).toBeTruthy()
  })

  it('treats team names case-insensitively, so "team alpha" is not a second team', async () => {
    await submitAs()
    const second = await submitAs({ teamName: 'team alpha' })
    expect(second.version).toBe(2)

    const { total } = await getSubmissions({ challengeId }, 50, 0)
    expect(total).toBe(1)
  })

  it('allows the same team to enter a different challenge', async () => {
    const other = await inScope(() => createChallenge({ name: 'Challenge Beta', actor: ACTOR }))
    await publishRubricFor(other.challengeId)
    await submitAs()
    const beta = await submitAs({ challengeId: other.challengeId })
    expect(beta.version).toBe(1)
  })
})

describe('build declaration (E03-S03)', () => {
  it('accepts a DOCKERFILE declaration whose path exists', async () => {
    const s = await submitAs({
      buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', buildCommand: undefined,
    })
    expect(s.validationStatus).toBe('VALID')
  })

  it('REJECTS a DOCKERFILE declaration whose path is not in the repository (acceptance 2)', async () => {
    const s = await submitAs({
      buildMethod: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile', buildCommand: undefined,
    })
    expect(s.validationStatus).toBe('REJECTED')
    expect(s.validationDetail).toMatch(/does not contain 'deploy\/Dockerfile'/)
  })

  it('refuses DOCKERFILE with no path', async () => {
    await expect(submitAs({
      buildMethod: 'DOCKERFILE', buildCommand: undefined,
    })).rejects.toThrow(/requires the path to the Dockerfile/)
  })

  it('refuses COMMAND with no command', async () => {
    await expect(submitAs({ buildCommand: undefined }))
      .rejects.toThrow(/requires a single build command/)
  })

  it('refuses a Dockerfile path that escapes the repository (P8.6)', async () => {
    await expect(submitAs({
      buildMethod: 'DOCKERFILE', dockerfilePath: '../../etc/passwd', buildCommand: undefined,
    })).rejects.toThrow(/not a valid path/)
  })
})

describe('revalidation until the window closes (E03-S02 acceptance 4, risk R8)', () => {
  it('detects a repository that goes private after submission', async () => {
    const s = await submitAs()
    expect(s.validationStatus).toBe('VALID')

    setRepoScript('team-alpha', {
      failWith: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    })
    const after = await inScope(() => revalidate(s.submissionId))
    expect(after.validationStatus).toBe('PRIVATE')
  })

  it('records a regression in the audit trail, so it cannot pass unnoticed', async () => {
    const s = await submitAs()
    setRepoScript('team-alpha', { failWith: 'fatal: repository not found' })
    await inScope(() => revalidate(s.submissionId))

    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event
        WHERE action = 'submissions.validation_regressed'`)
    expect(rows.rows[0]!.n).toBe(1)
  })

  it('keeps a full validation history, not just the current status', async () => {
    const s = await submitAs()
    setRepoScript('team-alpha', { failWith: 'fatal: repository not found' })
    await inScope(() => revalidate(s.submissionId))
    setRepoScript('team-alpha', { files: withEntry({ 'README.md': '# back' }) })
    await inScope(() => revalidate(s.submissionId))

    const history = await getValidationHistory(s.submissionId)
    expect(history.map((h) => h.status)).toEqual(['VALID', 'PRIVATE', 'VALID'])
  })

  it('re-checks everything due and reports what regressed', async () => {
    await submitAs()
    await submitAs({ teamName: 'Team Beta', repoUrl: 'https://github.com/team-beta/p' })
    await query('UPDATE submission SET validated_at = now() - interval \'1 day\'')

    setRepoScript('team-beta', { failWith: 'fatal: repository not found' })
    const result = await inScope(() => revalidateDue())
    expect(result.checked).toBe(2)
    expect(result.regressed).toBe(1)
  })
})

describe('window enforcement and lock (E03-S04)', () => {
  it('reports intake as open inside the window', async () => {
    expect((await intakeStatus()).state).toBe('OPEN')
  })

  it('REFUSES a submission after the deadline, with a clear message (acceptance 1)', async () => {
    await query(`UPDATE submission_window SET closes_at = now() - interval '1 hour'`)
    await expect(submitAs()).rejects.toThrow(/Submissions closed at/)
  })

  it('refuses a submission before the window opens', async () => {
    await query(`UPDATE submission_window SET opens_at = now() + interval '1 hour',
                                              closes_at = now() + interval '2 hours'`)
    await expect(submitAs()).rejects.toThrow(/Submissions open at/)
  })

  it('records the HEAD commit of every valid submission at lock (acceptance 2)', async () => {
    await submitAs()
    await submitAs({ teamName: 'Team Beta', repoUrl: 'https://github.com/team-beta/p' })

    const result = await inScope(() => lockWindow(ACTOR))
    expect(result.locked).toBe(2)

    const rows = await query<{ locked_commit_sha: string; locked_at: Date }>(
      'SELECT locked_commit_sha, locked_at FROM submission WHERE is_current')
    for (const row of rows.rows) {
      expect(row.locked_commit_sha).toMatch(/^[0-9a-f]{40}$/)
      expect(row.locked_at).toBeTruthy()
    }
  })

  it('locks even when one repository cannot be read, and reports which', async () => {
    await submitAs()
    await submitAs({ teamName: 'Team Beta', repoUrl: 'https://github.com/team-beta/p' })
    setRepoScript('team-beta', { failWith: 'fatal: repository not found' })

    const result = await inScope(() => lockWindow(ACTOR))
    expect(result.locked).toBe(2)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.teamName).toBe('Team Beta')
  })

  it('refuses writes once locked, and audits the lock with its actor (acceptance 3)', async () => {
    await inScope(() => lockWindow(ACTOR))
    expect((await intakeStatus()).state).toBe('LOCKED')
    await expect(submitAs()).rejects.toThrow(/locked/i)

    const rows = await query<{ actor: string; payload: { locked: number } }>(
      `SELECT actor, payload FROM audit_event WHERE action = 'submissions.window_locked'`)
    expect(rows.rows[0]?.actor).toBe(ACTOR)
  })

  it('CHANGES the open window rather than opening a second one', async () => {
    /*
     * It used to refuse. That left an organiser who had typed the wrong deadline with only one
     * way out — locking intake, which is permanent — while the screen offered a "Change the
     * window" button the API would not honour. Two open windows are still impossible, which was
     * the real point of the refusal.
     */
    const closesAt = new Date('2026-10-04T13:00:00Z')
    const changed = await inScope(() => openWindow({
      name: 'Corrected', opensAt: new Date('2026-10-02T13:00:00Z'), closesAt, actor: ACTOR,
    }))

    expect(changed.name).toBe('Corrected')
    expect(new Date(changed.closesAt).toISOString()).toBe(closesAt.toISOString())
    const rows = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM submission_window WHERE locked_at IS NULL')
    expect(rows.rows[0]?.n).toBe(1)
  })

  it('leaves a LOCKED window alone and opens a new one instead', async () => {
    // Locking is what makes "the deadline has passed" mean something (E38), so a locked window's
    // times never move. Opening another afterwards is a separate, deliberate act.
    const locked = await inScope(() => lockWindow(ACTOR))
    const fresh = await inScope(() => openWindow({
      name: 'A second event', opensAt: new Date(), closesAt: new Date(Date.now() + 86_400_000),
      actor: ACTOR,
    }))

    expect(fresh.windowId).not.toBe(locked.windowId)
    const was = await query<{ name: string; locked_at: Date | null }>(
      'SELECT name, locked_at FROM submission_window WHERE window_id = $1', [locked.windowId])
    expect(was.rows[0]?.name).not.toBe('A second event')
    expect(was.rows[0]?.locked_at).not.toBeNull()
  })
})

describe('intake dashboard counts (E03-S05 acceptance 1)', () => {
  it('reports real backend counts by challenge and status', async () => {
    await submitAs()
    setRepoScript('team-beta', { failWith: 'fatal: repository not found' })
    await submitAs({ teamName: 'Team Beta', repoUrl: 'https://github.com/team-beta/p' })
    await submitAs({
      teamName: 'Team Gamma', repoUrl: 'https://bitbucket.org/gamma/p',
    })

    const health = await getIntakeHealth()
    const row = health.find((h) => h.challengeId === challengeId)
    expect(row).toMatchObject({ total: 3, valid: 1, private: 1, rejected: 1 })
  })

  it('counts build methods, so the prober load is predictable', async () => {
    await submitAs()
    await submitAs({
      teamName: 'Team Beta', buildMethod: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile', buildCommand: undefined,
    })
    const row = (await getIntakeHealth()).find((h) => h.challengeId === challengeId)
    expect(row).toMatchObject({ dockerfileBuilds: 1, commandBuilds: 1 })
  })
})
