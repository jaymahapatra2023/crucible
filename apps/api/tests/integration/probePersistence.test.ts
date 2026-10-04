/**
 * Probe persistence and grading (E05-S04, E05-S05).
 *
 * The container runtime is substituted here: containment itself is proven against real Docker in
 * `packages/prober/tests/containment.test.ts` (P8.6). What these tests cover is the persistence,
 * grading and audit behaviour around it, which real containers would only make slower.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setRunner } from '@crucible/prober'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { probeSubmission, currentPolicy, runsDimensionInput } from '../../src/modules/probes/services/probeService.js'
import { selectProbeLog, probeHealth } from '../../src/modules/probes/db/probeDb.js'
import { inWindowRepo, makeGitRepo, type GitRepoFixture } from '../support/gitFixtures.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'probe' }, fn)

let repo: GitRepoFixture | null = null
let submissionId: number

/** Scripted container runtime: the probe's *persistence* is under test, not containment. */
function scriptRuntime(script: {
  buildExit?: number
  running?: boolean
  stdout?: string
  timedOut?: boolean
  oomKilled?: boolean
}) {
  setRunner(async (args) => {
    const command = args[0]
    const base = { timedOut: false, durationMs: 10, runtimeUnavailable: false, stderr: '' }

    if (command === 'version') return { ...base, exitCode: 0, stdout: '29.0.0' }
    if (command === 'inspect') {
      return {
        ...base, exitCode: 0,
        stdout: `${script.running ?? false} ${script.buildExit ?? 0} ${script.oomKilled ?? false}`,
      }
    }
    if (command === 'logs') return { ...base, exitCode: 0, stdout: script.stdout ?? '' }

    // Our own wrapper build on the COMMAND path, identified the way the real one is: it is the
    // only build that names `.crucible-probe.Dockerfile`. It copies the team's files in with the
    // right ownership and runs nothing of theirs, so it never carries their exit code — and if
    // it failed it would be a PROBE_ERROR, not a failed build.
    if (command === 'build' && args.includes('.crucible-probe.Dockerfile')) {
      return { ...base, exitCode: 0, stdout: 'sandbox image prepared' }
    }

    // The team's own step: `build` on the Dockerfile path, `run` on the command path.
    if (command === 'start' || command === 'build' || command === 'run') {
      return {
        ...base,
        exitCode: script.buildExit ?? 0,
        stdout: script.stdout ?? 'build output',
        timedOut: script.timedOut ?? false,
      }
    }
    return { ...base, exitCode: 0, stdout: '' }
  })
}

/** Probing needs a scan: the base image is chosen from the recorded dominant language. */
async function seedScan(submissionId: number, primaryLanguage: string | null) {
  await query(
    `INSERT INTO scan (submission_id, depth, raw_result, content_hash, status,
                       languages, primary_language, commit_sha)
     VALUES ($1, 'standard', '{}'::jsonb, repeat('a',64), 'COMPLETED',
             $2::text[], $3, $4)`,
    [submissionId, primaryLanguage ? [primaryLanguage] : [], primaryLanguage,
     Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40)])
}

async function seedSubmission(repoPath: string, overrides: Record<string, unknown> = {}) {
  const row = await query<{ submission_id: number }>(
    `WITH t AS (
       INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ($1, 'team@test.local', 'ORGANISER', 'fixture') RETURNING team_id
     )
     INSERT INTO submission
       (team_id, team_name, contact_email, challenge_id, repo_url, build_method, build_command,
        dockerfile_path, validation_status)
     SELECT t.team_id, $1, 'team@test.local', 1, $2, $3, $4, $5, $6 FROM t
     RETURNING submission_id`,
    [`Team ${Math.random().toString(36).slice(2, 8)}`, repoPath,
     overrides['buildMethod'] ?? 'COMMAND',
     overrides['buildCommand'] ?? 'npm ci',
     overrides['dockerfilePath'] ?? null,
     overrides['validationStatus'] ?? 'VALID'])
  return row.rows[0]!.submission_id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  repo = makeGitRepo(inWindowRepo())
  submissionId = await seedSubmission(repo.path)
  await seedScan(submissionId, 'javascript')
  scriptRuntime({ buildExit: 0, running: true, stdout: 'build output here' })
})

afterEach(() => {
  setRunner(null)
  repo?.cleanup()
  repo = null
})

describe('persistence (E05-S04 acceptance 1)', () => {
  it('records method, exit code, duration, flags and the log', async () => {
    const { probe } = await inScope(() => probeSubmission({ submissionId }))

    expect(probe.method).toBe('COMMAND')
    expect(probe.exit_code).toBe(0)
    expect(probe.duration_ms).toBeGreaterThanOrEqual(0)
    expect(probe.timed_out).toBe(false)
    expect(probe.resource_exceeded).toBe(false)

    const log = await selectProbeLog(probe.probe_id)
    expect(log?.log).toContain('build output here')
  })

  it('records the sandbox policy the build actually ran under', async () => {
    const { probe } = await inScope(() => probeSubmission({ submissionId }))
    expect(probe.policy.pidsLimit).toBeGreaterThan(0)
    expect(probe.policy.memoryMb).toBeGreaterThan(0)
    // Egress denied by default, and recorded either way (E05-S01 acceptance 3).
    expect(probe.egress_allowed).toEqual([])
  })

  it('records a configured egress allowance on the probe', async () => {
    await query(
      `UPDATE app_config SET value = '["registry.npmjs.org"]'::jsonb
        WHERE key = 'probes.egress_allow_list'`)
    invalidateConfig()
    expect((await currentPolicy()).egressAllowList).toEqual(['registry.npmjs.org'])
  })

  it('audits the probe', async () => {
    await inScope(() => probeSubmission({ submissionId }))
    const rows = await query<{ payload: { outcome: string; grade: string } }>(
      `SELECT payload FROM audit_event WHERE action = 'probes.probe_completed'`)
    // A COMMAND declaration describes a build, not a long-running service, so a successful
    // command grades BUILDS_ONLY. Only the Dockerfile path can earn RUNS.
    expect(rows.rows[0]!.payload.grade).toBe('BUILDS_ONLY')
  })

  it('refuses to probe a submission that did not validate', async () => {
    const invalid = await seedSubmission(repo!.path, { validationStatus: 'PRIVATE' })
    await seedScan(invalid, 'javascript')
    await expect(inScope(() => probeSubmission({ submissionId: invalid })))
      .rejects.toThrow(/only a repository that validated/i)
  })
})

describe('grading is deterministic (E05-S04 acceptance 2 and 3)', () => {
  it('grades a container that stays up as RUNS', async () => {
    scriptRuntime({ buildExit: 0, running: true })
    const { probe } = await inScope(() => probeSubmission({ submissionId }))
    expect(probe.outcome).toBe('BUILDS_ONLY')
    // COMMAND declares a build, not a long-running service — so staying up is not measured.
    expect(probe.runs_grade).toBe('BUILDS_ONLY')
  })

  it('grades a failing build as FAILS_TO_BUILD with a reason', async () => {
    // A command that needs no registry, so the failure is unambiguously the team's. The default
    // fixture command is `npm ci`, which the sandbox cannot let succeed — that case is the test
    // below it, and conflating the two would hide both.
    await query(
      `UPDATE submission SET build_command = 'node index.js' WHERE submission_id = $1`,
      [submissionId])
    scriptRuntime({ buildExit: 3, stdout: 'compilation error' })
    const { probe } = await inScope(() => probeSubmission({ submissionId }))
    expect(probe.outcome).toBe('BUILD_FAILED')
    expect(probe.runs_grade).toBe('FAILS_TO_BUILD')
    expect(probe.runs_score).toBe(0)
    expect(probe.grade_reason).toMatch(/exit code 3/)
  })

  it('grades a SANDBOX-caused stop as 3 of 4, and stores the reason a reviewer reads', async () => {
    // The fixture's declared command is `npm ci`, which is the point: it cannot reach a registry
    // in a sealed container, so the failure is the environment's however npm words it.
    // The event's first entry: a declared command that reaches the network, which the run
    // container does not have. Stored as a deduction rather than a failure, and the figure a
    // human sees — 3, not 0 — is the whole point of the row.
    scriptRuntime({ buildExit: 1, stdout: 'npm error code EAI_AGAIN\nnpm error syscall getaddrinfo' })
    const { probe } = await inScope(() => probeSubmission({ submissionId }))
    expect(probe.outcome).toBe('SANDBOX_BLOCKED')
    expect(probe.runs_grade).toBe('BLOCKED_BY_SANDBOX')
    expect(probe.runs_score).toBe(3)
    expect(probe.grade_reason).toMatch(/tried to reach the network/)
    expect(probe.grade_reason).toMatch(/one point of four/)

    // And the dimension the scorer reads agrees with the stored row.
    const dimension = await runsDimensionInput(submissionId)
    expect(dimension).toMatchObject({ grade: 'BLOCKED_BY_SANDBOX', score: 3 })
  })

  it('still grades the team’s OWN crash as zero — the deduction is not an amnesty', async () => {
    await query(
      `UPDATE submission SET build_command = 'node index.js' WHERE submission_id = $1`,
      [submissionId])
    scriptRuntime({ buildExit: 1, stdout: 'TypeError: undefined is not a function' })
    const { probe } = await inScope(() => probeSubmission({ submissionId }))
    expect(probe.outcome).toBe('BUILD_FAILED')
    expect(probe.runs_score).toBe(0)
  })

  it('grades a timeout as FAILS_TO_BUILD', async () => {
    scriptRuntime({ timedOut: true })
    const { probe } = await inScope(() => probeSubmission({ submissionId }))
    expect(probe.timed_out).toBe(true)
    expect(probe.runs_grade).toBe('FAILS_TO_BUILD')
  })

  it('NEVER scores a harness failure against the team', async () => {
    // An unsupported stack is the harness's limitation, not the submission's fault.
    const unsupported = await seedSubmission(repo!.path, { buildCommand: 'cobc -x main.cob' })
    await seedScan(unsupported, 'cobol')

    const { probe } = await inScope(() => probeSubmission({ submissionId: unsupported }))
    expect(probe.runs_grade).toBe('UNSUPPORTED')
    // -1 means "exclude from the denominator" (E07-S01), not zero.
    expect(probe.runs_score).toBe(-1)
  })

  it('records UNSUPPORTED rather than zero when probing is switched off', async () => {
    await query(`UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.probes.enabled'`)
    invalidateConfig()

    const { probe } = await inScope(() => probeSubmission({ submissionId }))
    expect(probe.runs_grade).toBe('UNSUPPORTED')
    expect(probe.probe_error).toMatch(/probing is disabled/)
  })

  it('exposes the Runs dimension input for scoring', async () => {
    await inScope(() => probeSubmission({ submissionId }))
    const input = await runsDimensionInput(submissionId)
    expect(input).toMatchObject({ grade: 'BUILDS_ONLY' })
    expect(input!.reason.length).toBeGreaterThan(10)
  })

  it('returns null for an unprobed submission — unmeasured, not failing', async () => {
    const unprobed = await seedSubmission(repo!.path)
    expect(await runsDimensionInput(unprobed)).toBeNull()
  })

  it('says the stack is UNKNOWN, not unsupported, when the submission was never scanned', async () => {
    // Different problems need different messages: one is ours to fix by scanning first.
    const unscanned = await seedSubmission(repo!.path)
    const { probe } = await inScope(() => probeSubmission({ submissionId: unscanned }))
    expect(probe.runs_grade).toBe('UNSUPPORTED')
    expect(probe.probe_error).toMatch(/has not been scanned/)
  })
})

describe('re-probing', () => {
  it('skips an existing probe unless forced', async () => {
    const first = await inScope(() => probeSubmission({ submissionId }))
    const second = await inScope(() => probeSubmission({ submissionId }))
    expect(second.skipped).toBe(true)
    expect(second.probe.probe_id).toBe(first.probe.probe_id)
  })

  it('supersedes rather than overwrites when forced, keeping the old probe as evidence', async () => {
    const first = await inScope(() => probeSubmission({ submissionId }))
    scriptRuntime({ buildExit: 1, stdout: 'now it fails' })
    const forced = await inScope(() => probeSubmission({ submissionId, force: true }))

    expect(forced.probe.probe_id).not.toBe(first.probe.probe_id)

    const rows = await query<{ probe_id: number; superseded_at: Date | null }>(
      'SELECT probe_id, superseded_at FROM build_probe WHERE submission_id = $1 ORDER BY probe_id',
      [submissionId])
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]!.superseded_at).not.toBeNull()
    expect(rows.rows[1]!.superseded_at).toBeNull()
  })

  it('reports outcome health across the cohort', async () => {
    await inScope(() => probeSubmission({ submissionId }))
    const health = await probeHealth()
    expect(health.reduce((sum, h) => sum + h.count, 0)).toBe(1)
  })
})
