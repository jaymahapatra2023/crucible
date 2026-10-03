/**
 * Scheduled re-validation (E03-S02 acceptance 4, risk R8) and the scheduler itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installFakeGit, restoreGit, setRepoScript } from '../support/fakeGit.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import {
  runTaskNow, scheduleTask, stopAllTasks, taskStatus,
} from '../../src/modules/platform/jobs/scheduler.js'
import {
  REVALIDATION_TASK, installRevalidationJob, revalidationTick,
} from '../../src/modules/submissions/jobs/revalidationJob.js'
import { createChallenge } from '../../src/modules/challenges/services/challengeService.js'
import {
  approveRubric, createVersion, freezeRubric, setDimensionWeights,
} from '../../src/modules/rubrics/services/rubricService.js'
import { publishRubric } from '../../src/modules/rubrics/services/rubricExport.js'
import { submit } from '../../src/modules/submissions/services/submissionService.js'
import { lockWindow, openWindow } from '../../src/modules/submissions/services/windowService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'sched' }, fn)
const anchors = { 0: 'none', 1: 'named', 2: 'unused', 3: 'works', 4: 'tested' }

let challengeId: number

async function seedPublishedChallenge() {
  const challenge = await inScope(() => createChallenge({ name: 'Challenge Alpha', actor: ACTOR }))
  const rubric = await inScope(() => createVersion({
    challengeId: challenge.challengeId,
    criteria: [{
      dimension: 'CHALLENGE_FIDELITY', name: 'Solves it',
      description: 'Whether the submission solves the stated problem.', weight: 1,
      evidenceSpec: 'A reader can point to the code.', anchors, sourceRef: 'brief §1', sortOrder: 0,
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
  return challenge.challengeId
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  stopAllTasks()
  installFakeGit()
  challengeId = await seedPublishedChallenge()
  await inScope(() => openWindow({
    name: 'Event', opensAt: new Date(Date.now() - 3600_000),
    closesAt: new Date(Date.now() + 3600_000), actor: ACTOR,
  }))
})

afterEach(() => {
  stopAllTasks()
  restoreGit()
})

const entry = (overrides: Record<string, unknown> = {}) => ({
  teamName: 'Team Alpha', contactEmail: 'alpha@team.test', challengeId,
  repoUrl: 'https://github.com/team-alpha/project',
  buildMethod: 'COMMAND' as const, buildCommand: 'npm ci', actor: 'token:Team Alpha',
  ...overrides,
})

/** Identity is a team id since E17-S02; the fixture makes the record the name stands for. */
const submitAs = async (overrides: Record<string, unknown> = {}) => {
  const input = entry(overrides)
  const team = await query<{ team_id: number }>(
    `INSERT INTO team (display_name, contact_email, origin, created_by)
     VALUES ($1, 'team@test.local', 'ORGANISER', 'fixture') RETURNING team_id`,
    [String(input.teamName)])
  return inScope(() => submit({
    ...input, teamId: Number(team.rows[0]!.team_id), via: 'TEAM_TOKEN',
  }))
}

describe('revalidation tick', () => {
  it('re-checks stale submissions and reports regressions', async () => {
    await submitAs()
    await query(`UPDATE submission SET validated_at = now() - interval '1 day'`)

    setRepoScript('team-alpha', { failWith: 'fatal: repository not found' })
    const result = await revalidationTick()
    expect(result).toMatchObject({ checked: 1, regressed: 1 })

    const rows = await query<{ validation_status: string }>(
      'SELECT validation_status FROM submission WHERE is_current')
    expect(rows.rows[0]?.validation_status).toBe('PRIVATE')
  })

  it('does nothing once intake is locked — the evaluated commit is already fixed', async () => {
    await submitAs()
    await inScope(() => lockWindow(ACTOR))
    expect(await revalidationTick()).toEqual({ skipped: 'intake is LOCKED' })
  })

  it('does nothing when there is no window', async () => {
    await query('TRUNCATE submission_window RESTART IDENTITY CASCADE')
    expect(await revalidationTick()).toEqual({ skipped: 'intake is NO_WINDOW' })
  })

  it('can be switched off by feature flag', async () => {
    await query(
      `UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.submissions.revalidation'`)
    invalidateConfig()
    expect(await revalidationTick()).toEqual({ skipped: 'revalidation disabled' })
  })

  it('re-checks a PENDING entry on the next tick, not after the interval (E45-S02)', async () => {
    // PENDING means the checks ran out of time; the receipt promises they will run again shortly.
    await submitAs()
    await query(`UPDATE submission SET validation_status = 'PENDING', validated_at = now()`)

    const result = await revalidationTick()
    expect(result).toMatchObject({ checked: 1 })
    const row = await query<{ validation_status: string }>('SELECT validation_status FROM submission')
    expect(row.rows[0]!.validation_status).toBe('VALID')
  })

  it('leaves a fresh submission alone', async () => {
    await submitAs()
    // Just validated at submit time, so nothing is due.
    expect(await revalidationTick()).toMatchObject({ checked: 0 })
  })
})

describe('scheduler', () => {
  it('registers a task and reports its status', () => {
    installRevalidationJob()
    const status = taskStatus().find((t) => t.name === REVALIDATION_TASK)
    expect(status).toBeDefined()
    expect(status?.intervalMs).toBeGreaterThan(0)
  })

  it('ignores a duplicate registration rather than double-scheduling', () => {
    installRevalidationJob()
    installRevalidationJob()
    expect(taskStatus().filter((t) => t.name === REVALIDATION_TASK)).toHaveLength(1)
  })

  it('records a failure without throwing — a failing job must not take the process down', async () => {
    scheduleTask({
      name: 'test.always-fails',
      intervalMs: 3_600_000,
      run: async () => { throw new Error('upstream is down') },
    })
    await expect(runTaskNow('test.always-fails')).resolves.toBeUndefined()

    const status = taskStatus().find((t) => t.name === 'test.always-fails')
    expect(status?.failures).toBe(1)
    expect(status?.lastError).toBe('upstream is down')
  })

  it('does not overlap a task with itself', async () => {
    let concurrent = 0
    let peak = 0
    scheduleTask({
      name: 'test.slow',
      intervalMs: 3_600_000,
      run: async () => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await new Promise((r) => setTimeout(r, 40))
        concurrent--
      },
    })
    await Promise.all([runTaskNow('test.slow'), runTaskNow('test.slow'), runTaskNow('test.slow')])
    expect(peak).toBe(1)
  })

  it('counts successful runs', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    scheduleTask({ name: 'test.counts', intervalMs: 3_600_000, run })
    await runTaskNow('test.counts')
    await runTaskNow('test.counts')
    expect(taskStatus().find((t) => t.name === 'test.counts')?.runs).toBe(2)
  })

  it('ignores a request to run an unknown task', async () => {
    await expect(runTaskNow('test.does-not-exist')).resolves.toBeUndefined()
  })
})
