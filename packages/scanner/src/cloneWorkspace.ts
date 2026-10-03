/**
 * Ephemeral clone with a guaranteed commit snapshot (E04-S03).
 *
 * Two commitments:
 *
 *  - **The working directory is always removed**, including on failure. Fifty untrusted
 *    repositories per run makes a leaked clone a disk-space incident, and P8.6 treats submission
 *    content as hostile.
 *  - **The evaluated commit is recorded.** A re-run and an appeal must refer to the same code;
 *    "we scanned their repo" is not an answer six months later.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface CloneResult {
  /** Directory containing the checkout. Valid only inside `withClone`. */
  path: string
  commitSha: string | null
  headCommittedAt: string | null
  /** True when history was limited by the clone depth, so commit counts are lower bounds. */
  historyTruncated: boolean
}

export interface CloneOptions {
  /**
   * How much history to fetch. Depth 1 is enough to score the code, but provenance (E04-S06)
   * needs real history — so that story asks for a full clone and pays for it knowingly
   * (acceptance 4).
   */
  historyDepth?: number | 'full'
  timeoutMs?: number
  /**
   * The exact commit to check out, when one has been decided (E03-S04: the commit locked when
   * intake closed). Without it the clone is the default branch's HEAD — right before the lock,
   * wrong after it: a team that pushed past the deadline would be evaluated on the push. With
   * it, the checkout IS that commit or the clone fails, and `commitSha` reports it.
   */
  commit?: string
}

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: process.env['HOME'] ?? '/tmp',
  // Behave exactly as an anonymous visitor would: never prompt, never use a stored credential.
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/echo',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  LC_ALL: 'C',
}

async function git(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  const { stdout } = await run('git', args, {
    ...(cwd !== undefined && { cwd }),
    env: GIT_ENV,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.trim()
}

/**
 * Clone into a disposable directory, hand it to `fn`, and remove it afterwards.
 *
 * The callback shape is deliberate: returning a path would make cleanup the caller's problem,
 * and a caller that throws would leak the clone.
 */
export async function withClone<T>(
  repoUrl: string,
  options: CloneOptions,
  fn: (clone: CloneResult) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 180_000
  const historyDepth = options.historyDepth ?? 1
  const workspace = await mkdtemp(join(tmpdir(), 'crucible-scan-'))
  const path = join(workspace, 'repo')

  try {
    const args = ['clone', '--quiet', '--no-tags']
    if (historyDepth !== 'full') args.push('--depth', String(historyDepth))
    args.push(repoUrl, path)

    await git(args, undefined, timeoutMs)

    if (options.commit !== undefined) {
      if (!/^[0-9a-f]{40}$/.test(options.commit)) {
        throw new Error(`Not a commit sha: ${options.commit}`)
      }
      // A shallow clone holds only HEAD; fetch the decided commit by sha (which every major
      // host allows) and check it out. Detached, deliberately — nothing here needs a branch.
      await git(['fetch', '--quiet', '--no-tags', ...(historyDepth === 'full' ? [] : ['--depth', String(historyDepth)]),
        'origin', options.commit], path, timeoutMs)
      await git(['checkout', '--quiet', '--detach', options.commit], path, 60_000)
    }

    const commitSha = await safely(() => git(['rev-parse', 'HEAD'], path, 30_000))
    const headCommittedAt = await safely(() => git(['log', '-1', '--format=%cI'], path, 30_000))
    const shallow = await safely(() => git(['rev-parse', '--is-shallow-repository'], path, 30_000))

    return await fn({
      path,
      commitSha: commitSha && /^[0-9a-f]{40}$/.test(commitSha) ? commitSha : null,
      headCommittedAt: headCommittedAt || null,
      historyTruncated: shallow === 'true',
    })
  } finally {
    // Always, including on failure (E04-S03 acceptance 1).
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Read HEAD of an existing checkout. */
export async function readCommitSha(repoPath: string): Promise<string | null> {
  const sha = await safely(() => git(['rev-parse', 'HEAD'], repoPath, 30_000))
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

export async function readHeadCommittedAt(repoPath: string): Promise<string | null> {
  return (await safely(() => git(['log', '-1', '--format=%cI'], repoPath, 30_000))) || null
}

export async function isShallow(repoPath: string): Promise<boolean> {
  return (await safely(() => git(['rev-parse', '--is-shallow-repository'], repoPath, 30_000))) === 'true'
}

/** Raw git output for provenance. Returns null rather than throwing on a repo with no history. */
export async function readLog(repoPath: string, format: string, timeoutMs = 60_000): Promise<string | null> {
  return safely(() => git(['log', `--format=${format}`], repoPath, timeoutMs))
}

export async function readNumstat(repoPath: string, timeoutMs = 60_000): Promise<string | null> {
  return safely(() => git(['log', '--numstat', '--format=__commit__%H'], repoPath, timeoutMs))
}

async function safely(fn: () => Promise<string>): Promise<string | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}
