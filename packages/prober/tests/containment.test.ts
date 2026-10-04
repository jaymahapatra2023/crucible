/**
 * THE SECURITY GATE (E05-S01 acceptance 6, P8.6, risk R1).
 *
 * Crucible executes build commands from fifty untrusted repositories. This suite runs genuinely
 * hostile code inside the sandbox and asserts the host is unaffected.
 *
 * Two rules govern this file:
 *
 *  1. **It must not be skipped.** If no container runtime is available the tests FAIL rather
 *    than skip. P8.6 is explicit that a green suite without containment evidence is not evidence
 *    of anything, and a silently-skipped security test is exactly that.
 *  2. **The attacks are real.** A simulated fork bomb proves nothing about a PID limit.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY, HOSTILE_FIXTURES, assertPolicySafe, benignFixture, containmentArgs,
  gradeRuns, probe, runtimeAvailable, withEgress, type HostileFixture,
} from '../src/index.js'
import { makeRepo, type FixtureRepo } from '../../scanner/src/testFixtures.js'

/** Tight limits: the attacks should hit them quickly rather than after five minutes. */
const POLICY = {
  ...DEFAULT_POLICY,
  timeoutMs: 90_000,
  settleSeconds: 2,
  memoryMb: 256,
  cpus: 1,
  pidsLimit: 48,
}

let repo: FixtureRepo | null = null

beforeAll(async () => {
  // A canary on the HOST process. If the container can see it, the environment was inherited —
  // which is the precise thing E05-S01 acceptance 5 forbids, tested directly rather than by
  // guessing which variable names look sensitive.
  process.env['CRUCIBLE_HOST_CANARY'] = 'this-must-never-be-visible-inside-a-probe'
  process.env['CRUCIBLE_FAKE_TOKEN'] = 'sk-not-a-real-credential-but-shaped-like-one'

  const available = await runtimeAvailable()
  if (!available) {
    // Deliberately a failure, not a skip.
    throw new Error(
      'No container runtime is available, so the containment gate cannot run. P8.6 requires ' +
      'this evidence on every change: a green suite without it proves nothing. Start Docker ' +
      'and re-run, or fix the runtime in CI — do not disable this suite.',
    )
  }
}, 60_000)

afterEach(() => {
  repo?.cleanup()
  repo = null
})

function buildRepo(fixture: HostileFixture | typeof benignFixture): string {
  repo = makeRepo(fixture.files)
  return repo.path
}

describe('the policy itself', () => {
  it('denies network egress by default (acceptance 3)', () => {
    const args = containmentArgs(DEFAULT_POLICY)
    expect(args).toContain('--network')
    expect(args).toContain('none')
  })

  it('applies memory, CPU and PID limits (acceptance 4)', () => {
    const args = containmentArgs(POLICY).join(' ')
    expect(args).toContain('--memory=256m')
    expect(args).toContain('--memory-swap=256m')
    expect(args).toContain('--cpus=1')
    expect(args).toContain('--pids-limit=48')
  })

  it('drops all capabilities and forbids privilege escalation (P8.5)', () => {
    const args = containmentArgs(DEFAULT_POLICY).join(' ')
    expect(args).toContain('--cap-drop ALL')
    expect(args).toContain('no-new-privileges')
  })

  it('runs untrusted code as a non-root user', () => {
    expect(containmentArgs(DEFAULT_POLICY).join(' ')).toContain('--user 1000:1000')
  })

  it('mounts NOTHING from the host (acceptance 2)', () => {
    const args = containmentArgs(DEFAULT_POLICY)
    expect(args).not.toContain('-v')
    expect(args).not.toContain('--volume')
    expect(args).not.toContain('--mount')
    expect(args.join(' ')).not.toContain('docker.sock')
  })

  it('records an egress allowance rather than granting it silently', () => {
    const permissive = withEgress(DEFAULT_POLICY, ['registry.npmjs.org'])
    expect(permissive.egressAllowList).toEqual(['registry.npmjs.org'])
    expect(containmentArgs(permissive)).not.toContain('none')
  })

  it('REFUSES to run under an unsafe policy', () => {
    expect(() => assertPolicySafe({ ...POLICY, memoryMb: 0 })).toThrow(/unsafe sandbox policy/)
    expect(() => assertPolicySafe({ ...POLICY, pidsLimit: 999_999 })).toThrow()
    expect(() => assertPolicySafe({ ...POLICY, timeoutMs: 999_999_999 })).toThrow()
  })
})

describe('a well-behaved submission still works', () => {
  it('builds successfully', async () => {
    const result = await probe({
      repoPath: buildRepo(benignFixture),
      buildMethod: 'COMMAND',
      buildCommand: benignFixture.buildCommand,
      language: benignFixture.language,
      policy: POLICY,
    })
    expect(result.probeError).toBeNull()
    expect(result.buildExitCode).toBe(0)
    expect(result.log).toContain('built successfully')
  }, 300_000)
})

describe('hostile submissions are CONTAINED (acceptance 6)', () => {
  it.each(HOSTILE_FIXTURES.map((f) => [f.name, f] as const))(
    'contains the %s attack',
    async (_name, fixture) => {
      const result = await probe({
        repoPath: buildRepo(fixture),
        buildMethod: 'COMMAND',
        buildCommand: fixture.buildCommand,
        language: fixture.language,
        policy: POLICY,
      })

      // Every fixture prints ESCAPED if it got out. That string appearing anywhere is a breach.
      expect(
        result.log,
        `${fixture.name} escaped containment. Expected control: ${fixture.expectedControl}`,
      ).not.toContain('ESCAPED')

      // And the probe must have *observed* the containment rather than hanging.
      expect(result.outcome).not.toBe('RUNS')
    },
    300_000,
  )

  it('leaves NO trace on the host filesystem', () => {
    // The host-write fixture targets these paths. None may exist afterwards.
    for (const path of ['/etc/crucible-escaped', '/host/crucible-escaped', join(homedir(), 'crucible-escaped')]) {
      expect(existsSync(path), `${path} was created — containment failed`).toBe(false)
    }
  })

  it('the network fixture reports no egress at all', async () => {
    const fixture = HOSTILE_FIXTURES.find((f) => f.name === 'network-callout')!
    const result = await probe({
      repoPath: buildRepo(fixture),
      buildMethod: 'COMMAND',
      buildCommand: fixture.buildCommand,
      language: fixture.language,
      policy: POLICY,
    })
    expect(result.log).toContain('CONTAINED: no egress')
    expect(result.log).toMatch(/blocked example\.com/)
  }, 300_000)

  it('the credential fixture sees none of the operator’s environment (acceptance 5)', async () => {
    const fixture = HOSTILE_FIXTURES.find((f) => f.name === 'credential-theft')!
    const result = await probe({
      repoPath: buildRepo(fixture),
      buildMethod: 'COMMAND',
      buildCommand: fixture.buildCommand,
      language: fixture.language,
      policy: POLICY,
    })
    expect(result.log).toContain('CONTAINED')
    expect(result.log).not.toContain('CRUCIBLE_HOST_CANARY')
    expect(result.log).not.toContain('CRUCIBLE_FAKE_TOKEN')
    expect(result.log).not.toMatch(/ANTHROPIC_API_KEY|JWT_SECRET|DATABASE_URL/)
  }, 300_000)

  it('the fork bomb is stopped by the PID limit', async () => {
    const fixture = HOSTILE_FIXTURES.find((f) => f.name === 'fork-bomb')!
    const result = await probe({
      repoPath: buildRepo(fixture),
      buildMethod: 'COMMAND',
      buildCommand: fixture.buildCommand,
      language: fixture.language,
      policy: POLICY,
    })
    expect(result.log).not.toContain('ESCAPED')
    // Either the fork was refused, or the container was killed for exceeding its limit.
    expect(
      result.log.includes('CONTAINED') || result.resourceExceeded || result.timedOut,
    ).toBe(true)
  }, 300_000)
})

describe('grading is deterministic and never model-scored (E05-S04)', () => {
  it('maps each outcome to a fixed grade', () => {
    const base = { method: 'COMMAND' as const, buildDurationMs: 0, stayedUp: false,
      runDurationMs: 0, timedOut: false, resourceExceeded: false, log: '', logTruncated: false,
      logBytes: 0, egressAllowed: [], baseImage: null, probeError: null,
      ranAt: '', totalDurationMs: 0, buildExitCode: 0 }

    expect(gradeRuns({ ...base, outcome: 'RUNS' }).grade).toBe('RUNS')
    expect(gradeRuns({ ...base, outcome: 'BUILDS_ONLY' }).grade).toBe('BUILDS_ONLY')
    expect(gradeRuns({ ...base, outcome: 'BUILD_FAILED' }).grade).toBe('FAILS_TO_BUILD')
    expect(gradeRuns({ ...base, outcome: 'TIMED_OUT' }).grade).toBe('FAILS_TO_BUILD')
    expect(gradeRuns({ ...base, outcome: 'RESOURCE_EXCEEDED' }).grade).toBe('FAILS_TO_BUILD')
  })

  it('does NOT score a harness failure against the submission', () => {
    const base = { method: 'COMMAND' as const, buildDurationMs: 0, stayedUp: false,
      runDurationMs: 0, timedOut: false, resourceExceeded: false, log: '', logTruncated: false,
      logBytes: 0, egressAllowed: [], baseImage: null, probeError: 'runtime down',
      ranAt: '', totalDurationMs: 0, buildExitCode: null }

    // -1 means "exclude from the denominator", not "zero".
    expect(gradeRuns({ ...base, outcome: 'PROBE_ERROR' }).score).toBe(-1)
    expect(gradeRuns({ ...base, outcome: 'UNSUPPORTED_STACK' }).grade).toBe('UNSUPPORTED')
  })

  it('is a pure function of the probe result — the same result always grades the same', () => {
    const result = { method: 'DOCKERFILE' as const, outcome: 'RUNS' as const, buildExitCode: 0,
      buildDurationMs: 100, stayedUp: true, runDurationMs: 2000, timedOut: false,
      resourceExceeded: false, log: 'x', logTruncated: false, logBytes: 1,
      egressAllowed: [], baseImage: null, probeError: null, ranAt: '', totalDurationMs: 2100 }
    expect(gradeRuns(result)).toEqual(gradeRuns(result))
  })
})

describe('the sandbox leaves nothing behind (acceptance 1)', () => {
  it('removes every container it created', async () => {
    const { docker } = await import('../src/containerRuntime.js')
    await probe({
      repoPath: buildRepo(benignFixture),
      buildMethod: 'COMMAND',
      buildCommand: benignFixture.buildCommand,
      language: benignFixture.language,
      policy: POLICY,
    })

    const listed = await docker(['ps', '--all', '--format', '{{.Names}}'], {
      timeoutMs: 30_000, capBytes: 64 * 1024,
    })
    expect(listed.stdout).not.toMatch(/crucible-(cmd|run)-/)
  }, 300_000)

  it('removes every IMAGE it created too', async () => {
    // Containers were checked here from the start; images were not, and a leak went unnoticed
    // until a tagged sandbox image was found sitting in the local store after a probe run.
    // Thirty submissions times two runs is sixty images, each carrying a copy of a repository.
    const { docker } = await import('../src/containerRuntime.js')
    await probe({
      repoPath: buildRepo(benignFixture),
      buildMethod: 'COMMAND',
      buildCommand: benignFixture.buildCommand,
      language: benignFixture.language,
      policy: POLICY,
    })

    const images = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      timeoutMs: 30_000, capBytes: 256 * 1024,
    })
    expect(images.stdout).not.toMatch(/^crucible-(cmd|probe):/m)
  }, 300_000)
})

describe('where the container starts (the WORKDIR override)', () => {
  it('starts the COMMAND path in /work, which is where the repository was copied', () => {
    const args = containmentArgs(DEFAULT_POLICY).join(' ')
    expect(args).toContain('--workdir /work')
    expect(args).toContain('HOME=/work')
  })

  it('leaves a Dockerfile image its OWN working directory', () => {
    // The defect this pins: forcing /work onto an image that declares `WORKDIR /app` makes a
    // relative CMD unresolvable, the container exits immediately, and the probe records "built
    // successfully but did not stay running" — a wrong grade on a dimension a team is judged by,
    // for the most ordinary Dockerfile there is.
    const args = containmentArgs(DEFAULT_POLICY, { workdir: null })
    expect(args).not.toContain('--workdir')
    expect(args.join(' ')).toContain('HOME=/tmp')
  })

  it('keeps every containment control when the working directory is left alone', () => {
    const args = containmentArgs(DEFAULT_POLICY, { workdir: null }).join(' ')
    expect(args).toContain('--network none')
    expect(args).toContain('--memory=2048m')
    expect(args).toContain('--memory-swap=2048m')
    expect(args).toContain('--cpus=2')
    expect(args).toContain('--pids-limit=256')
    expect(args).toContain('--security-opt no-new-privileges')
    expect(args).toContain('--cap-drop ALL')
    expect(args).toContain('--user 1000:1000')
  })
})
