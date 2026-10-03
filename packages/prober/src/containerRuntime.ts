/**
 * Container runtime adapter (P12.2).
 *
 * The only file that speaks to Docker. Everything else works in terms of probes, so swapping the
 * runtime — or substituting it in a test — is one file.
 */
import { spawn } from 'node:child_process'

export interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  /** True when the runtime itself could not be reached, as distinct from the command failing. */
  runtimeUnavailable: boolean
}

export interface RunOptions {
  timeoutMs: number
  /** Combined output retained, in bytes. Beyond this, output is discarded rather than buffered. */
  capBytes: number
  cwd?: string
  /** Sent to stdin, for piping a build context. */
  input?: Buffer
}

export type Runner = (args: readonly string[], options: RunOptions) => Promise<RunOutcome>

let runner: Runner | null = null

/**
 * Test seam.
 *
 * Note what this is *not* used for: the containment tests run against real Docker, because a
 * substituted runtime would prove only that the substitute honours the flags. P8.6 requires the
 * adversarial fixture to be genuinely contained.
 */
export function setRunner(fn: Runner | null): void {
  runner = fn
}

export async function docker(args: readonly string[], options: RunOptions): Promise<RunOutcome> {
  if (runner) return runner(args, options)
  return spawnDocker(args, options)
}

function spawnDocker(args: readonly string[], options: RunOptions): Promise<RunOutcome> {
  const started = Date.now()

  return new Promise<RunOutcome>((resolve) => {
    const child = spawn('docker', args, {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      // A deliberately minimal environment: nothing of the host's is passed through, so a
      // credential in the operator's shell cannot reach a build (E05-S01 acceptance 5).
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
        DOCKER_HOST: process.env['DOCKER_HOST'] ?? '',
      },
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let runtimeUnavailable = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    const append = (current: string, chunk: Buffer): string =>
      current.length >= options.capBytes ? current : current + chunk.toString('utf8')

    child.stdout?.on('data', (c: Buffer) => { stdout = append(stdout, c) })
    child.stderr?.on('data', (c: Buffer) => { stderr = append(stderr, c) })

    if (options.input) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(options.input)
    }

    child.on('error', () => {
      runtimeUnavailable = true
      finish(null)
    })
    child.on('close', (code) => finish(code))

    function finish(code: number | null): void {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        runtimeUnavailable,
      })
    }
  })
}

/** Whether a container runtime is reachable. */
export async function runtimeAvailable(): Promise<boolean> {
  const result = await docker(['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 10_000, capBytes: 4096,
  })
  return result.exitCode === 0 && !result.runtimeUnavailable
}

/** Remove a container by name, ignoring "not found". Used to guarantee cleanup. */
export async function forceRemove(containerName: string): Promise<void> {
  await docker(['rm', '--force', containerName], { timeoutMs: 30_000, capBytes: 4096 })
    .catch(() => undefined)
}

export async function removeImage(imageTag: string): Promise<void> {
  await docker(['image', 'rm', '--force', imageTag], { timeoutMs: 60_000, capBytes: 4096 })
    .catch(() => undefined)
}
