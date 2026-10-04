/**
 * The command path (E05-S03).
 *
 * Teams without a Dockerfile must not be disadvantaged (acceptance 1), so their declared command
 * runs in a standard base image chosen from the detected stack.
 *
 * The repository reaches the container inside a thin image built around the base — never
 * mounted (E05-S01 acceptance 2). The command is a team-supplied string, so anything it can
 * reach, it can write.
 *
 * **Why an image rather than `docker cp` into a created container**, which is what this did
 * first: `docker cp` leaves the copied tree owned by whoever owns it on the host, and `/work`
 * itself owned by root, while the container runs as `--user 1000:1000` for containment. The
 * result was that the team's command could not write to its own working directory. Every
 * ordinary first step fails that way — `npm install` dies on EACCES opening
 * `/work/package-lock.json`, and `pip install`, `go build` and `mvn package` all do the same —
 * so the probe recorded "built but did not stay running" for a team whose code it never ran.
 * That is the worst grade on a dimension they are judged by, awarded for our plumbing.
 *
 * `COPY --chown=1000:1000` in a build step puts the ownership right before anything of theirs
 * executes, and run-time containment is unchanged: the same `containmentArgs`, the same sealed
 * network, the same unprivileged user. The build is ours, not the team's, and runs no code of
 * theirs — it only copies files.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { docker, forceRemove, removeImage } from '../containerRuntime.js'
import { baseImageFor, supportedLanguages } from '../baseImages.js'
import { containmentArgs } from '../sandboxPolicy.js'
import { emptyResult, hitResourceLimit, withLog, type ProbeContext, type ProbeStrategy } from './probeContract.js'
import type { ProbeInput, ProbeResult } from '../types.js'

const run = promisify(execFile)

/**
 * Named with a leading dot and our own prefix so it cannot collide with a file the team wrote.
 * It is added to the build context only — the team's working tree is never written to.
 */
const WRAPPER = '.crucible-probe.Dockerfile'

export const commandStrategy: ProbeStrategy = {
  method: 'COMMAND',

  canRun(input: ProbeInput) {
    if (!input.buildCommand?.trim()) {
      return { ok: false as const, reason: 'No build command was declared.' }
    }
    if (!baseImageFor(input.language)) {
      // Not the team's fault: recorded as unsupported, never scored against them (acceptance 3).
      return {
        ok: false as const,
        reason: input.language === undefined
          // Distinct from an unsupported stack: this is a sequencing problem on our side.
          ? 'The submission has not been scanned, so its stack is unknown. Scan before probing.'
          : `No base image matches '${input.language}'. Supported: ${supportedLanguages().join(', ')}.`,
      }
    }
    return { ok: true as const }
  },

  async run(input: ProbeInput, context: ProbeContext): Promise<ProbeResult> {
    const started = Date.now()
    const result = emptyResult(input)
    const base = baseImageFor(input.language)

    if (!base) {
      result.outcome = 'UNSUPPORTED_STACK'
      result.probeError = null
      return withLog({ result, buildOutput: '', runOutput: 'No matching base image for the detected stack.', capBytes: input.policy.logCapBytes, startedAt: started })
    }
    result.baseImage = base.image

    const imageTag = `crucible-cmd:${context.handle}`
    const containerName = `crucible-cmd-${context.handle}`
    // Cleanups run in reverse registration order, so the image is registered first and the
    // container second: the container must go before the image it is built from, or the removal
    // is refused while anything still holds it.
    context.onCleanup(() => removeImage(imageTag))
    context.onCleanup(() => forceRemove(containerName))

    // Ours, not the team's: it copies their files to /work with the ownership the container will
    // run as, and does nothing else. No RUN step, so no code of theirs executes in the build.
    const wrapper = [
      `FROM ${base.image}`,
      // Explicit, because some base images declare a non-root USER and the chown below needs
      // to succeed. Run-time identity is set by `--user` on the run, not by this.
      'USER root',
      'COPY --chown=1000:1000 . /work',
      // The directory ITSELF, not just its contents. `COPY --chown` sets the ownership of what
      // it copies; /work is created by the COPY (or by a WORKDIR) as root, and a root-owned
      // working directory is unwritable even when everything inside it is owned by 1000 —
      // creating a new file needs write permission on the directory. That was the actual defect:
      // ownership of the files was never the problem, ownership of the folder was.
      'RUN chown 1000:1000 /work',
      'WORKDIR /work',
      '',
    ].join('\n')

    const build = await docker([
      'build',
      '--file', WRAPPER,
      '--tag', imageTag,
      // No cache shared between submissions, for the same reason as the Dockerfile path: one
      // team's layers must not influence another's.
      '--no-cache',
      '-',
    ], {
      timeoutMs: input.policy.timeoutMs,
      capBytes: input.policy.logCapBytes,
      input: await buildContext(input.repoPath, wrapper),
    })

    if (build.runtimeUnavailable) {
      result.probeError = 'The container runtime is not available.'
      return withLog({ result, buildOutput: build.stderr, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }
    if (build.exitCode !== 0) {
      // Our step failed, so it is reported as a probe error rather than a failed build. Grading
      // a team down for a stage they did not write is the thing this path exists to avoid.
      result.probeError =
        `Could not prepare the sandbox image: ${build.stderr.slice(0, 500)}`
      return withLog({ result, buildOutput: `${build.stdout}\n${build.stderr}`, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }

    // Containment is identical to before — the same flags, including the sealed network and the
    // unprivileged user. Only where the files came from has changed.
    const startOutcome = await docker([
      'run',
      // Named, so a container that outlives its timeout can still be removed. `--rm` handles the
      // ordinary exit; it does nothing for a command that is still running when we stop waiting,
      // and an anonymous container of that kind would keep its image alive for good.
      '--name', containerName,
      ...containmentArgs(input.policy),
      imageTag,
      'sh', '-c', `cd /work && ${input.buildCommand}`,
    ], {
      timeoutMs: input.policy.timeoutMs,
      capBytes: input.policy.logCapBytes,
    })

    if (startOutcome.runtimeUnavailable) {
      result.probeError = 'The container runtime is not available.'
      return withLog({ result, buildOutput: '', runOutput: startOutcome.stderr, capBytes: input.policy.logCapBytes, startedAt: started })
    }

    const output = `${startOutcome.stdout}\n${startOutcome.stderr}`
    result.buildExitCode = startOutcome.exitCode
    result.buildDurationMs = startOutcome.durationMs

    if (startOutcome.timedOut) {
      result.timedOut = true
      result.outcome = 'TIMED_OUT'
      return withLog({ result, buildOutput: output, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }

    result.resourceExceeded = hitResourceLimit(startOutcome.exitCode, output)
    if (result.resourceExceeded) {
      result.outcome = 'RESOURCE_EXCEEDED'
      return withLog({ result, buildOutput: output, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }
    if (startOutcome.exitCode !== 0) {
      result.outcome = 'BUILD_FAILED'
      return withLog({ result, buildOutput: output, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
    }

    // The command completed successfully. A build command that returns is a build that worked;
    // whether a long-running process stays up is what the Dockerfile path measures, and a team
    // that declared only a build command has not told us how to start anything.
    result.outcome = 'BUILDS_ONLY'
    result.stayedUp = false
    return withLog({ result, buildOutput: output, runOutput: '', capBytes: input.policy.logCapBytes, startedAt: started })
  },
}



/**
 * Build context as a tar stream: the repository, plus our wrapper Dockerfile at its root.
 *
 * The wrapper is written to a temporary directory and tarred alongside the repository rather
 * than into it. Writing it into the clone would put a file in the tree the team's command sees,
 * and the probe has no business modifying its own input.
 *
 * Absolute paths for both `-C` segments: BSD tar applies each one relative to the last, so a
 * relative second directory is not found.
 */
async function buildContext(repoPath: string, wrapper: string): Promise<Buffer> {
  const staging = await mkdtemp(join(tmpdir(), 'crucible-probe-'))
  try {
    await writeFile(join(staging, WRAPPER), wrapper, 'utf8')
    const { stdout } = await run('tar', ['-c', '-C', resolve(repoPath), '.', '-C', staging, '.'], {
      encoding: 'buffer', maxBuffer: 512 * 1024 * 1024,
    })
    return stdout
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
