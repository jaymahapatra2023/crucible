/**
 * Build-method strategies against real containers (E05-S02, E05-S03, E05-S04).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY, baseImageFor, captureLog, gradeRuns, probe, runtimeAvailable,
  strategyFor, supportedLanguages, supportedMethods,
} from '../src/index.js'
import { makeRepo, type FixtureRepo } from '../../scanner/src/testFixtures.js'

const POLICY = {
  ...DEFAULT_POLICY, timeoutMs: 180_000, settleSeconds: 3,
  memoryMb: 512, cpus: 1, pidsLimit: 128,
}

let repo: FixtureRepo | null = null

beforeAll(async () => {
  if (!(await runtimeAvailable())) {
    throw new Error('No container runtime available; the probe suite cannot run (P8.6).')
  }
}, 60_000)

afterEach(() => {
  repo?.cleanup()
  repo = null
})

const build = (files: Record<string, string>): string => {
  repo = makeRepo(files)
  return repo.path
}

describe('Dockerfile path (E05-S02)', () => {
  it('builds from the declared path and starts the container', async () => {
    const path = build({
      'build/Dockerfile': [
        'FROM alpine:3.20',
        'RUN echo "build step ran"',
        'CMD ["sh", "-c", "echo service up; sleep 600"]',
      ].join('\n'),
      'README.md': '# Long-running service\n',
    })

    const result = await probe({
      repoPath: path, buildMethod: 'DOCKERFILE', dockerfilePath: 'build/Dockerfile', policy: POLICY,
    })

    expect(result.probeError).toBeNull()
    expect(result.buildExitCode).toBe(0)
    expect(result.log).toContain('build step ran')
    // Stayed up for the settle period (acceptance 2).
    expect(result.stayedUp).toBe(true)
    expect(result.outcome).toBe('RUNS')
    expect(gradeRuns(result)).toMatchObject({ grade: 'RUNS', score: 4 })
  }, 300_000)

  it('records BUILDS_ONLY when the container exits immediately', async () => {
    const path = build({
      'Dockerfile': 'FROM alpine:3.20\nCMD ["echo", "done and gone"]\n',
    })
    const result = await probe({
      repoPath: path, buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', policy: POLICY,
    })

    expect(result.buildExitCode).toBe(0)
    expect(result.stayedUp).toBe(false)
    expect(result.outcome).toBe('BUILDS_ONLY')
    expect(gradeRuns(result).grade).toBe('BUILDS_ONLY')
  }, 300_000)

  it('records BUILD_FAILED with the build log when the build breaks', async () => {
    const path = build({
      'Dockerfile': 'FROM alpine:3.20\nRUN echo "about to fail" && exit 42\n',
    })
    const result = await probe({
      repoPath: path, buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', policy: POLICY,
    })

    expect(result.outcome).toBe('BUILD_FAILED')
    expect(result.buildExitCode).not.toBe(0)
    // The log is what lets a reviewer tell a broken submission from a broken prober (E05-S05).
    expect(result.log).toContain('about to fail')
    expect(gradeRuns(result)).toMatchObject({ grade: 'FAILS_TO_BUILD', score: 0 })
  }, 300_000)

  it('refuses a Dockerfile path that escapes the repository', async () => {
    const result = await probe({
      repoPath: build({ 'a.txt': 'x' }),
      buildMethod: 'DOCKERFILE', dockerfilePath: '../../etc/passwd', policy: POLICY,
    })
    expect(result.outcome).toBe('UNSUPPORTED_STACK')
    expect(result.probeError).toMatch(/not a path inside the repository/)
  }, 60_000)

  it('refuses a DOCKERFILE declaration with no path', async () => {
    const result = await probe({
      repoPath: build({ 'a.txt': 'x' }), buildMethod: 'DOCKERFILE', policy: POLICY,
    })
    expect(result.outcome).toBe('UNSUPPORTED_STACK')
  }, 60_000)

  it('re-executes build steps for every submission rather than reusing another\u2019s layers', async () => {
    // One team's layers must not influence another's build. Asserted by observing that the RUN
    // step actually executes the second time — a cached layer produces no output. Asserting the
    // absence of the word "CACHED" would be brittle: BuildKit prints it for base-image
    // resolution regardless of --no-cache, which is not layer reuse between submissions.
    const dockerfile = 'FROM alpine:3.20\nRUN echo "BUILD-STEP-EXECUTED"\n'

    const first = await probe({
      repoPath: build({ 'Dockerfile': dockerfile }),
      buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', policy: POLICY,
    })
    repo?.cleanup()
    const second = await probe({
      repoPath: build({ 'Dockerfile': dockerfile }),
      buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', policy: POLICY,
    })

    expect(first.buildExitCode).toBe(0)
    expect(second.buildExitCode).toBe(0)
    expect(first.log).toContain('BUILD-STEP-EXECUTED')
    expect(second.log).toContain('BUILD-STEP-EXECUTED')
  }, 300_000)

  it('passes --no-cache on every build', async () => {
    // The flag is the control; the test above shows it has the intended effect.
    const { setRunner } = await import('../src/containerRuntime.js')
    const seen: string[][] = []
    setRunner(async (args) => {
      seen.push([...args])
      // The runtime check must succeed, or the probe short-circuits before reaching the build.
      const ok = args[0] === 'version'
      return {
        exitCode: ok ? 0 : 1, stdout: ok ? '29.0.0' : '', stderr: ok ? '' : 'stopped',
        timedOut: false, durationMs: 1, runtimeUnavailable: false,
      }
    })
    try {
      await probe({
        repoPath: build({ 'Dockerfile': 'FROM alpine:3.20\n' }),
        buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', policy: POLICY,
      })
      const buildArgs = seen.find((a) => a[0] === 'build')
      expect(buildArgs).toBeDefined()
      expect(buildArgs).toContain('--no-cache')
    } finally {
      setRunner(null)
    }
  }, 60_000)
})

describe('command path (E05-S03)', () => {
  it('runs the declared command in a base image matched to the stack', async () => {
    const result = await probe({
      repoPath: build({ 'build.js': 'console.log("node build ok")' }),
      buildMethod: 'COMMAND', buildCommand: 'node build.js', language: 'javascript',
      policy: POLICY,
    })
    expect(result.baseImage).toBe('node:22-bookworm-slim')
    expect(result.buildExitCode).toBe(0)
    expect(result.log).toContain('node build ok')
  }, 300_000)

  it('captures a failing command’s exit code and output', async () => {
    const result = await probe({
      repoPath: build({ 'build.py': 'import sys\nprint("failing now")\nsys.exit(7)\n' }),
      buildMethod: 'COMMAND', buildCommand: 'python3 build.py', language: 'python',
      policy: POLICY,
    })
    expect(result.outcome).toBe('BUILD_FAILED')
    expect(result.buildExitCode).toBe(7)
    expect(result.log).toContain('failing now')
  }, 300_000)

  it('records UNSUPPORTED_STACK rather than failing the submission (acceptance 3)', async () => {
    const result = await probe({
      repoPath: build({ 'main.cob': 'IDENTIFICATION DIVISION.' }),
      buildMethod: 'COMMAND', buildCommand: 'cobc -x main.cob', language: 'cobol',
      policy: POLICY,
    })
    expect(result.outcome).toBe('UNSUPPORTED_STACK')
    expect(result.probeError).toMatch(/No base image matches 'cobol'/)
    // Excluded from the denominator, not scored as zero — the team did nothing wrong.
    expect(gradeRuns(result)).toMatchObject({ grade: 'UNSUPPORTED', score: -1 })
  }, 60_000)

  it('copies the repository in — the team’s files are present', async () => {
    const result = await probe({
      repoPath: build({
        'data.txt': 'the repository was copied in',
        'read.py': 'print(open("data.txt").read())',
      }),
      buildMethod: 'COMMAND', buildCommand: 'python3 read.py', language: 'python',
      policy: POLICY,
    })
    expect(result.log).toContain('the repository was copied in')
  }, 300_000)

  it('CAN WRITE to its own working directory — every real build command does', async () => {
    /*
     * The regression that cost a team the runs dimension at the event. `docker cp` left /work
     * owned by root with the files owned by the host user, while the container runs as
     * --user 1000:1000, so the first thing any ordinary build does — write a lock file, a
     * build directory, a compiled artefact — died with EACCES before the team's code ran.
     *
     * Every test above this one only READ, which is why the suite was green throughout.
     */
    const result = await probe({
      repoPath: build({
        'write.py': 'open("artefact.txt", "w").write("built")\nprint("wrote", open("artefact.txt").read())',
      }),
      buildMethod: 'COMMAND', buildCommand: 'python3 write.py', language: 'python',
      policy: POLICY,
    })
    expect(result.probeError).toBeNull()
    expect(result.buildExitCode).toBe(0)
    expect(result.log).toContain('wrote built')
    expect(result.log).not.toMatch(/EACCES|Permission denied/i)
  }, 300_000)

  it('can create a directory in the working tree, as a package install does', async () => {
    const result = await probe({
      repoPath: build({ 'mk.py': 'import os\nos.makedirs("deps/pkg")\nprint("made", os.path.isdir("deps/pkg"))' }),
      buildMethod: 'COMMAND', buildCommand: 'python3 mk.py', language: 'python',
      policy: POLICY,
    })
    expect(result.buildExitCode).toBe(0)
    expect(result.log).toContain('made True')
  }, 300_000)

  it('grades a REAL no-network failure as blocked by the sandbox, not as a failed build', async () => {
    /*
     * The event's first entry, reduced to its essence: a declared command that reaches the
     * network. It cannot work and it is not their bug — the run container has no network by
     * design. Graded 3 of 4 rather than 0.
     *
     * Against a real container, because the point is what the sandbox actually does, not what
     * a fixture says it does.
     */
    const result = await probe({
      repoPath: build({
        'fetch.py': 'import urllib.request\nurllib.request.urlopen("https://pypi.org/simple/")',
      }),
      buildMethod: 'COMMAND', buildCommand: 'python3 fetch.py', language: 'python',
      policy: POLICY,
    })
    expect(result.outcome).toBe('SANDBOX_BLOCKED')
    expect(result.sandboxBlock?.control).toBe('NO_NETWORK')
    expect(gradeRuns(result)).toMatchObject({ grade: 'BLOCKED_BY_SANDBOX', score: 3 })
  }, 300_000)

  it('grades a REAL unprivileged-write failure the same way', async () => {
    const result = await probe({
      repoPath: build({ 'w.py': 'open("/etc/crucible-probe-test", "w").write("x")' }),
      buildMethod: 'COMMAND', buildCommand: 'python3 w.py', language: 'python',
      policy: POLICY,
    })
    expect(result.outcome).toBe('SANDBOX_BLOCKED')
    expect(result.sandboxBlock?.control).toBe('UNPRIVILEGED_USER')
    expect(gradeRuns(result).score).toBe(3)
  }, 300_000)

  /*
   * There is NO real-container test for the inference path, deliberately.
   *
   * One was written: a declared `npm install` against a sealed container. It passed, and it cost
   * seventy seconds — npm retries DNS for over a minute before giving up — while holding a
   * container the whole time. Added to a suite that already runs containers it starved an
   * unrelated API test until it timed out at fifteen minutes, which is a worse outcome than the
   * coverage was worth.
   *
   * The inference needs no container to prove: it is a function of the declared command and the
   * egress list, and `sandboxSignatures.test.ts` covers every package manager in milliseconds.
   * What containers are needed for is the containment itself, which the tests above exercise
   * with commands that fail instantly.
   */
  it('still grades an ORDINARY crash as a failed build — the deduction is not an amnesty', async () => {
    const result = await probe({
      repoPath: build({ 'bad.py': 'raise ValueError("this is the team\'s own bug")' }),
      buildMethod: 'COMMAND', buildCommand: 'python3 bad.py', language: 'python',
      policy: POLICY,
    })
    expect(result.outcome).toBe('BUILD_FAILED')
    expect(result.sandboxBlock).toBeNull()
    expect(gradeRuns(result)).toMatchObject({ grade: 'FAILS_TO_BUILD', score: 0 })
  }, 300_000)

  it('refuses a COMMAND declaration with no command', async () => {
    const result = await probe({
      repoPath: build({ 'a.txt': 'x' }), buildMethod: 'COMMAND', language: 'python',
      policy: POLICY,
    })
    expect(result.outcome).toBe('UNSUPPORTED_STACK')
  }, 60_000)

  it('times out a command that never finishes', async () => {
    const result = await probe({
      repoPath: build({ 'hang.py': 'import time\ntime.sleep(600)\n' }),
      buildMethod: 'COMMAND', buildCommand: 'python3 hang.py', language: 'python',
      policy: { ...POLICY, timeoutMs: 8_000 },
    })
    expect(result.timedOut).toBe(true)
    expect(result.outcome).toBe('TIMED_OUT')
    expect(gradeRuns(result).grade).toBe('FAILS_TO_BUILD')
  }, 120_000)
})

describe('base images and registry', () => {
  it('matches common hackathon stacks', () => {
    expect(baseImageFor('python')?.image).toMatch(/^python:/)
    expect(baseImageFor('go')?.image).toMatch(/^golang:/)
    expect(baseImageFor('rust')?.image).toMatch(/^rust:/)
    expect(baseImageFor('cobol')).toBeNull()
    expect(baseImageFor(undefined)).toBeNull()
  })

  it('pins every base image to a version rather than latest', () => {
    for (const language of supportedLanguages()) {
      const image = baseImageFor(language)!.image
      expect(image, `${language} uses an unpinned tag`).not.toMatch(/:latest$/)
      expect(image).toContain(':')
    }
  })

  it('registers exactly the two declared build methods (P1.5)', () => {
    expect(supportedMethods().sort()).toEqual(['COMMAND', 'DOCKERFILE'])
    expect(strategyFor('DOCKERFILE')).not.toBeNull()
    expect(strategyFor('COMMAND')).not.toBeNull()
  })
})

describe('log capture (E05-S02 acceptance 3)', () => {
  it('keeps short logs whole', () => {
    const captured = captureLog('build output', '', 1024)
    expect(captured.truncated).toBe(false)
    expect(captured.text).toContain('build output')
  })

  it('truncates a long log and SAYS so', () => {
    const captured = captureLog('x'.repeat(100_000), '', 2_000)
    expect(captured.truncated).toBe(true)
    expect(captured.text).toMatch(/bytes omitted/)
    expect(captured.originalBytes).toBeGreaterThan(2_000)
  })

  it('keeps the TAIL as well as the head — the tail holds why it stopped', () => {
    const captured = captureLog(
      `START-MARKER${'x'.repeat(50_000)}END-MARKER`, '', 2_000)
    expect(captured.text).toContain('START-MARKER')
    expect(captured.text).toContain('END-MARKER')
  })

  it('labels stdout and stderr separately', () => {
    const captured = captureLog('out', 'err', 4096)
    expect(captured.text).toContain('--- stdout ---')
    expect(captured.text).toContain('--- stderr ---')
  })
})
