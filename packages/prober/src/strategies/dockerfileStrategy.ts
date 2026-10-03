/**
 * The Dockerfile path (E05-S02).
 *
 * Builds from the team's own Dockerfile and starts the result, so the score reflects the team's
 * own definition of "running" (acceptance 2).
 *
 * The repository is sent as a build context over stdin — never mounted (E05-S01 acceptance 2).
 * A bind mount would give a `RUN` step write access to the host, and a Dockerfile is code the
 * team wrote.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { docker, forceRemove, removeImage } from '../containerRuntime.js'
import { containmentArgs } from '../sandboxPolicy.js'
import { emptyResult, hitResourceLimit, withLog, type ProbeContext, type ProbeStrategy } from './probeContract.js'
import type { ProbeInput, ProbeResult } from '../types.js'

const run = promisify(execFile)

export const dockerfileStrategy: ProbeStrategy = {
  method: 'DOCKERFILE',

  canRun(input: ProbeInput) {
    const path = input.dockerfilePath?.trim()
    if (!path) {
      return { ok: false as const, reason: 'No Dockerfile path was declared.' }
    }
    if (path.startsWith('/') || path.includes('..')) {
      return { ok: false as const, reason: `'${path}' is not a path inside the repository.` }
    }
    return { ok: true as const }
  },

  async run(input: ProbeInput, context: ProbeContext): Promise<ProbeResult> {
    const started = Date.now()
    const result = emptyResult(input)
    const imageTag = `crucible-probe:${context.handle}`
    const containerName = `crucible-run-${context.handle}`

    context.onCleanup(() => removeImage(imageTag))
    context.onCleanup(() => forceRemove(containerName))

    // ── Build ────────────────────────────────────────────────────────────────────────────
    // The context is a tar stream on stdin: nothing of the host filesystem is exposed.
    const contextTar = await tarball(input.repoPath)

    // `-` reads the context as a tar stream from stdin; `--file` is then interpreted relative
    // to the context root, which is exactly the path the team declared.
    const build = await docker([
      'build',
      '--file', input.dockerfilePath as string,
      '--tag', imageTag,
      // No cache shared between submissions: one team's layers must not influence another's
      // build, and a poisoned cache entry would cross the boundary between them.
      '--no-cache',
      '--pull=false',
      '-',
    ], {
      timeoutMs: input.policy.timeoutMs,
      capBytes: input.policy.logCapBytes,
      input: contextTar,
    })

    const buildOutput = `${build.stdout}\n${build.stderr}`
    result.buildExitCode = build.exitCode
    result.buildDurationMs = build.durationMs

    if (build.runtimeUnavailable) {
      result.probeError = 'The container runtime is not available.'
      result.outcome = 'PROBE_ERROR'
      return withLog({ result, buildOutput: buildOutput, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }
    if (build.timedOut) {
      result.timedOut = true
      result.outcome = 'TIMED_OUT'
      return withLog({ result, buildOutput: buildOutput, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }
    if (build.exitCode !== 0) {
      result.resourceExceeded = hitResourceLimit(build.exitCode, buildOutput)
      result.outcome = result.resourceExceeded ? 'RESOURCE_EXCEEDED' : 'BUILD_FAILED'
      return withLog({ result, buildOutput: buildOutput, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }

    // ── Start, and see whether it stays up ───────────────────────────────────────────────
    const settleMs = input.policy.settleSeconds * 1000
    const runOutcome = await docker([
      'run', '--name', containerName,
      // The image's own WORKDIR stands: a Dockerfile that sets `WORKDIR /app` and starts with a
      // relative CMD is the ordinary case, and forcing a directory on it stops the container
      // before it runs. Every containment control still applies.
      ...containmentArgs(input.policy, { workdir: null }).filter((a) => a !== '--rm'),
      '--detach',
      imageTag,
    ], { timeoutMs: 60_000, capBytes: input.policy.logCapBytes })

    if (runOutcome.exitCode !== 0) {
      result.outcome = 'BUILDS_ONLY'
      return withLog({ result, buildOutput: buildOutput, runOutput: `${runOutcome.stdout}\n${runOutcome.stderr}`, capBytes: input.policy.logCapBytes, startedAt: started })
    }

    await sleep(settleMs)

    const inspect = await docker(
      ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', containerName],
      { timeoutMs: 30_000, capBytes: 4096 })

    const logs = await docker(['logs', '--tail', '2000', containerName], {
      timeoutMs: 30_000, capBytes: input.policy.logCapBytes,
    })

    const [running, exitCode, oomKilled] = inspect.stdout.trim().split(/\s+/)
    result.stayedUp = running === 'true'
    result.runDurationMs = settleMs
    result.resourceExceeded = oomKilled === 'true' || hitResourceLimit(Number(exitCode), logs.stderr)
    result.outcome = result.resourceExceeded
      ? 'RESOURCE_EXCEEDED'
      : result.stayedUp ? 'RUNS' : 'BUILDS_ONLY'

    return withLog({ result, buildOutput: buildOutput, runOutput: `${logs.stdout}\n${logs.stderr}`, capBytes: input.policy.logCapBytes, startedAt: started })
  },
}



/** Build context as a tar stream. Produced with the host `tar`; no host path is exposed. */
async function tarball(repoPath: string): Promise<Buffer> {
  const { stdout } = await run('tar', ['-c', '-C', repoPath, '.'], {
    encoding: 'buffer', maxBuffer: 512 * 1024 * 1024,
  })
  return stdout
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
