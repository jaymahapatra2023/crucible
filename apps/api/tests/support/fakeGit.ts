/**
 * Scripted `git` for submission-intake tests.
 *
 * Substitutes the process boundary only. URL validation, host allow-listing, path-safety
 * checks, host-specific failure reading and Dockerfile confirmation all run against the real
 * implementations — which is where the behaviour under test actually lives.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setGitRunner, type GitResult } from '../../src/modules/submissions/services/gitClient.js'

export interface RepoScript {
  /** Files the clone should produce, relative to the repository root. */
  files?: Record<string, string>
  headSha?: string
  headCommittedAt?: string
  /** When set, the clone fails with this stderr instead of succeeding. */
  failWith?: string
  timeout?: boolean
}

const DEFAULT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** What a clone produces when a script names no files: a README and sixty lines of real code. */
export const DEFAULT_ENTRY: Record<string, string> = {
  'README.md': '# Project\n\nA real entry: run `npm start`.\n',
  'src/app.js': Array.from({ length: 60 }, (_, i) => `export function step${i}(x) { return x + ${i} }`).join('\n') + '\n',
}

/** A legitimate entry plus whatever a scenario needs on top — a Dockerfile, a changed README. */
export const withEntry = (extra: Record<string, string>): Record<string, string> =>
  ({ ...DEFAULT_ENTRY, ...extra })

/** Per-clone-URL scripts; `*` is the fallback. */
let scripts = new Map<string, RepoScript>()

const ok = (stdout = ''): GitResult => ({
  ok: true, code: 0, stdout, stderr: '', timedOut: false, durationMs: 5,
})

function scriptFor(url: string): RepoScript {
  for (const [key, script] of scripts) {
    if (key !== '*' && url.includes(key)) return script
  }
  return scripts.get('*') ?? {}
}

export function installFakeGit(initial: Record<string, RepoScript> = {}): void {
  scripts = new Map(Object.entries(initial))

  setGitRunner(async (args, options) => {
    const [command] = args

    if (command === 'clone') {
      const url = args.find((a) => a.startsWith('http')) ?? ''
      const target = args[args.length - 1] as string
      const script = scriptFor(url)

      if (script.timeout) {
        return { ok: false, code: null, stdout: '', stderr: '', timedOut: true, durationMs: options.timeoutMs }
      }
      if (script.failWith) {
        return { ok: false, code: 128, stdout: '', stderr: script.failWith, timedOut: false, durationMs: 20 }
      }

      await mkdir(target, { recursive: true })
      // The default clone is a LEGITIMATE entry: a README and enough real code to clear tier 1's
      // substantive-code floor (E45-S02). A script wanting a scaffold, or no README, says so.
      for (const [path, content] of Object.entries(script.files ?? DEFAULT_ENTRY)) {
        const full = join(target, path)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, content, 'utf8')
      }
      return ok()
    }

    if (command === 'rev-parse') {
      return ok(scriptForCwd(options.cwd).headSha ?? DEFAULT_SHA)
    }
    if (command === 'log') {
      return ok(scriptForCwd(options.cwd).headCommittedAt ?? '2026-09-20T12:00:00Z')
    }
    return ok()
  })
}

/** `rev-parse` runs inside the cloned directory, so the URL is no longer in the arguments. */
function scriptForCwd(_cwd: string | undefined): RepoScript {
  return scripts.get('*') ?? {}
}

export function setRepoScript(urlFragment: string, script: RepoScript): void {
  scripts.set(urlFragment, script)
}

export function restoreGit(): void {
  setGitRunner(null)
  scripts = new Map()
}
