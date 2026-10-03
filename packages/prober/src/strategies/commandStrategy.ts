/**
 * The command path (E05-S03).
 *
 * Teams without a Dockerfile must not be disadvantaged (acceptance 1), so their declared command
 * runs in a standard base image chosen from the detected stack.
 *
 * The repository is copied into the container with `docker cp` — never mounted (E05-S01
 * acceptance 2). The command is a team-supplied string, so anything it can reach, it can write.
 */
import { docker, forceRemove } from '../containerRuntime.js'
import { baseImageFor, supportedLanguages } from '../baseImages.js'
import { containmentArgs } from '../sandboxPolicy.js'
import { emptyResult, hitResourceLimit, withLog, type ProbeContext, type ProbeStrategy } from './probeContract.js'
import type { ProbeInput, ProbeResult } from '../types.js'

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

    const containerName = `crucible-cmd-${context.handle}`
    context.onCleanup(() => forceRemove(containerName))

    // Created stopped, so the repository can be copied in before anything of the team's runs.
    const create = await docker([
      'create', '--name', containerName,
      ...containmentArgs(input.policy).filter((a) => a !== '--rm'),
      base.image,
      'sh', '-c', `cd /work && ${input.buildCommand}`,
    ], { timeoutMs: 60_000, capBytes: input.policy.logCapBytes })

    if (create.runtimeUnavailable) {
      result.probeError = 'The container runtime is not available.'
      return withLog({ result, buildOutput: '', runOutput: create.stderr, capBytes: input.policy.logCapBytes, startedAt: started })
    }
    if (create.exitCode !== 0) {
      result.probeError = `Could not create the sandbox container: ${create.stderr.slice(0, 500)}`
      return withLog({ result, buildOutput: '', runOutput: create.stderr, capBytes: input.policy.logCapBytes, startedAt: started })
    }

    // Copied in, not mounted: the container gets its own copy and the host stays unreachable.
    const copy = await docker(['cp', `${input.repoPath}/.`, `${containerName}:/work`], {
      timeoutMs: 120_000, capBytes: input.policy.logCapBytes,
    })
    if (copy.exitCode !== 0) {
      result.probeError = `Could not copy the repository into the sandbox: ${copy.stderr.slice(0, 500)}`
      return withLog({ result, buildOutput: '', runOutput: copy.stderr, capBytes: input.policy.logCapBytes, startedAt: started })
    }

    const startOutcome = await docker(['start', '--attach', containerName], {
      timeoutMs: input.policy.timeoutMs,
      capBytes: input.policy.logCapBytes,
    })

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


