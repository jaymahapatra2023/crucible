/**
 * Thin, bounded wrapper around `git` (P12.2).
 *
 * Every invocation is time-limited, runs with credential prompting disabled, and captures
 * stderr — because stderr is where git says *why* it failed, and E03-S02 acceptance 2 requires
 * a specific reason rather than a generic error.
 *
 * Credential helpers are disabled deliberately: a validation clone must behave the same way it
 * would for an anonymous visitor. If the operator's own credentials could make a private
 * repository look reachable, intake would pass and evaluation night would fail.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

const OUTPUT_CAP = 64 * 1024

export type GitRunner = (
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<GitResult>

/**
 * Seam for tests.
 *
 * Replacing `git` itself — rather than the validation service above it — means URL checking,
 * path-safety checking, host-specific failure reading and Dockerfile confirmation all run for
 * real, and only the network boundary is substituted. Faking the validator instead would test
 * the fake.
 */
let runner: GitRunner | null = null

export function setGitRunner(fn: GitRunner | null): void {
  runner = fn
}

export async function runGit(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number } = { timeoutMs: 60_000 },
): Promise<GitResult> {
  if (runner) return runner(args, options)
  return spawnGit(args, options)
}

async function spawnGit(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<GitResult> {
  const started = Date.now()

  return new Promise<GitResult>((resolve) => {
    const child = spawn('git', args, {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
        // Never prompt, never use a stored credential, never read the operator's config.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/echo',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8')
    })

    const finish = (code: number | null) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        durationMs: Date.now() - started,
      })
    }

    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

/** Create a disposable working directory and always remove it, including on failure. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-git-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function shallowClone(
  repoUrl: string, targetDir: string, timeoutMs: number,
): Promise<GitResult> {
  return runGit(
    ['clone', '--depth', '1', '--no-tags', '--single-branch', '--quiet', repoUrl, targetDir],
    { timeoutMs },
  )
}

export async function headSha(repoDir: string, timeoutMs = 15_000): Promise<string | null> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: repoDir, timeoutMs })
  return result.ok && /^[0-9a-f]{40}$/.test(result.stdout) ? result.stdout : null
}

export async function headCommittedAt(repoDir: string, timeoutMs = 15_000): Promise<Date | null> {
  const result = await runGit(['log', '-1', '--format=%cI'], { cwd: repoDir, timeoutMs })
  if (!result.ok || result.stdout === '') return null
  const date = new Date(result.stdout)
  return Number.isNaN(date.getTime()) ? null : date
}
