/**
 * The pure rules of pre-flight (E46).
 *
 * The one that matters: UNKNOWN is never rendered as a failure (E46-S01 acceptance 3). A probe
 * the harness could not start says nothing about the team, and the email must say so.
 */
import { describe, expect, it } from 'vitest'
import {
  actionableKeys, check, findingsText, probeChecks, sameOutcome, unknown, verdictFor,
  type ProbeFacts,
} from './preflightVerdict.js'

const facts = (over: Partial<ProbeFacts> = {}): ProbeFacts => ({
  outcome: 'RUNS', exitCode: 0, stayedUp: true, timedOut: false, resourceExceeded: false,
  probeError: null, runDurationMs: 30_000, ...over,
})

describe('the verdict', () => {
  it('is READY only when every check passed', () => {
    expect(verdictFor([check('scan', 'PASS', 'ok'), check('build', 'PASS', 'ok')])).toBe('READY')
  })

  it('is PROBLEMS when anything failed, whatever else is unknown', () => {
    expect(verdictFor([check('build', 'FAIL', 'no'), unknown('run', 'skipped')])).toBe('PROBLEMS')
  })

  it('is UNKNOWN — never PROBLEMS — when the harness could not check something', () => {
    expect(verdictFor([check('scan', 'PASS', 'ok'), unknown('build', 'docker was down')])).toBe('UNKNOWN')
  })
})

describe('build and run, from one probe', () => {
  it('passes both for a probe that ran', () => {
    const [build, run] = probeChecks(facts(), 45)
    expect(build.status).toBe('PASS')
    expect(run.status).toBe('PASS')
    expect(run.summary).toContain('45 seconds')
  })

  it('fails the build, and does NOT fail the run, when the build failed', () => {
    const [build, run] = probeChecks(facts({ outcome: 'BUILD_FAILED', exitCode: 2 }), 45)
    expect(build.status).toBe('FAIL')
    expect(build.summary).toContain('exit code 2')
    expect(build.remedy).toMatch(/Build it locally/)
    expect(run.status).toBe('UNKNOWN')
    expect(run.remedy).toBeNull()
  })

  it('fails the run when the application exited early, and says what to look at', () => {
    const [build, run] = probeChecks(facts({ outcome: 'BUILDS_ONLY', exitCode: 1, stayedUp: false }), 45)
    expect(build.status).toBe('PASS')
    expect(run.status).toBe('FAIL')
    expect(run.remedy).toMatch(/environment variable|port/)
  })

  it('tells a team the SANDBOX stopped it, and that the scoring already allows for that', () => {
    // The distinction that matters to a team reading this at two in the morning: it failed,
    // there is something they can do, and they are not being marked down for our environment.
    const [build, run] = probeChecks(
      facts({ outcome: 'SANDBOX_BLOCKED', exitCode: 1, stayedUp: false }), 45)
    expect(build.status).toBe('PASS')
    expect(run.status).toBe('FAIL')
    expect(run.summary).toMatch(/sandbox denied/)
    expect(run.summary).toMatch(/one point of four, not the dimension/)
    expect(run.remedy).toMatch(/no network access|unprivileged/)
  })

  it('blames the build, not the run, when the build is what timed out', () => {
    const [build, run] = probeChecks(facts({ outcome: 'TIMED_OUT', timedOut: true, runDurationMs: 0 }), 45)
    expect(build.status).toBe('FAIL')
    expect(run.status).toBe('UNKNOWN')
  })

  it('is UNKNOWN for both when the harness itself failed — never the team', () => {
    const [build, run] = probeChecks(facts({ outcome: 'PROBE_ERROR', probeError: 'no docker' }), 45)
    expect(build.status).toBe('UNKNOWN')
    expect(run.status).toBe('UNKNOWN')
    expect(build.summary).toBe('no docker')
  })

  it('is UNKNOWN for an unsupported stack — a capability gap, not a fault', () => {
    expect(probeChecks(facts({ outcome: 'UNSUPPORTED_STACK' }), 45).map((c) => c.status))
      .toEqual(['UNKNOWN', 'UNKNOWN'])
  })
})

describe('what the team reads', () => {
  it('lists failures with what to do, and unknowns as "could not be checked"', () => {
    const text = findingsText([
      check('scan', 'PASS', 'read'),
      check('build', 'FAIL', 'The build failed.', { remedy: 'Fix it.' }),
      unknown('run', 'the build failed, so the application was not started.'),
    ])
    expect(text).toContain('- Build: The build failed. What to do: Fix it.')
    expect(text).toContain('- Runs: could not be checked — the build failed')
    expect(text).not.toContain('Repository read')
  })

  it('never says anything about a score', () => {
    const text = findingsText([check('secrets', 'FAIL', 'a key', { remedy: 'rotate' })])
    expect(text).not.toMatch(/score|points|rank|marks/i)
  })
})

describe('whether a repeat says anything new', () => {
  const run = (over: Partial<{ commitSha: string | null; verdict: 'READY' | 'PROBLEMS' | 'UNKNOWN' | null }> = {},
    checks = [check('build', 'FAIL', 'x')]) => ({
    commitSha: 'abc', verdict: 'PROBLEMS' as const, checks, ...over,
  })

  it('is the same outcome for the same commit, verdict and failing checks', () => {
    expect(sameOutcome(run(), run())).toBe(true)
  })

  it('is a new outcome when the commit changed, or a check flipped', () => {
    expect(sameOutcome(run(), run({ commitSha: 'def' }))).toBe(false)
    expect(sameOutcome(run(), run({}, [check('build', 'FAIL', 'x'), check('run', 'FAIL', 'y')]))).toBe(false)
    expect(sameOutcome(run(), run({}, [unknown('build', 'x')]))).toBe(false)
  })

  it('never treats an unknown commit as the same', () => {
    expect(sameOutcome(run({ commitSha: null }), run({ commitSha: null }))).toBe(false)
  })

  it('compares the non-passing keys in a stable order', () => {
    expect(actionableKeys([check('run', 'FAIL', 'a'), check('build', 'FAIL', 'b'), check('scan', 'PASS', 'c')]))
      .toEqual(['build:FAIL', 'run:FAIL'])
  })
})
