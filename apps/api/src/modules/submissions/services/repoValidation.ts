/**
 * Repository validation (E03-S02, E03-S03 acceptance 2).
 *
 * The whole point of this story is timing: catching an unreachable repository at *submit* time
 * makes it a support conversation on the day, while catching it on evaluation night makes it an
 * incident. So validation actually clones — a HEAD request would be cheaper and would not prove
 * the thing that matters.
 *
 * Every failure carries a specific, actionable reason. "Validation failed" tells a team nothing
 * they can fix.
 */
import { access } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { createLogger } from '../../../lib/logger.js'
import { getJson, getNumber } from '../../platform/services/configService.js'
import { headCommittedAt, headSha, shallowClone, withTempDir } from './gitClient.js'
import { hostFor, knownHostnames } from './hosts/hostRegistry.js'
import type { ValidationStatus } from './hosts/hostContract.js'

const log = createLogger('submissions', 'repoValidation')

export interface ValidationOutcome {
  status: ValidationStatus
  detail: string
  /** Present when the clone succeeded — the commit that was reachable at validation time. */
  commitSha?: string
  headCommittedAt?: Date
  /** Canonicalised clone URL, stored in place of whatever the team pasted. */
  normalisedUrl?: string
  durationMs: number
}

export interface ValidationInput {
  repoUrl: string
  buildMethod: 'DOCKERFILE' | 'COMMAND'
  dockerfilePath?: string | null
}

/** Well-formedness and allow-list, checked before any network call is made. */
export async function checkUrl(repoUrl: string): Promise<
  { ok: true; url: URL; normalised: string } | { ok: false; detail: string }
> {
  let url: URL
  try {
    url = new URL(repoUrl.trim())
  } catch {
    return { ok: false, detail: 'That is not a valid URL. Paste the full https:// address of the repository.' }
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      detail: `Only https:// URLs are accepted; this one uses ${url.protocol.replace(':', '')}.`,
    }
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      detail: 'Remove the credentials embedded in the URL. Evaluation runs anonymously against a public repository.',
    }
  }

  const allowed = await getJson<string[]>('submissions.allowed_hosts')
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!allowed.some((h) => h.toLowerCase() === hostname)) {
    return {
      ok: false,
      detail: `Repositories must be hosted on ${allowed.join(' or ')}. This one is on ${url.hostname}.`,
    }
  }

  const host = hostFor(url)
  if (!host) {
    return {
      ok: false,
      detail: `${url.hostname} is allow-listed but not supported. Supported: ${knownHostnames().join(', ')}.`,
    }
  }

  const normalised = host.normalise(url)
  if (!normalised) {
    return {
      ok: false,
      detail: 'The URL does not name a repository. It should look like https://github.com/team/project.',
    }
  }
  return { ok: true, url, normalised }
}

/**
 * A declared Dockerfile path must stay inside the repository.
 *
 * `../../etc/passwd` is not a build declaration, it is an attempt to make the prober read the
 * host. Rejected at intake so it never reaches E05 (P8.6).
 */
export function isSafeRepoPath(path: string): boolean {
  const trimmed = path.trim().replace(/^\.\//, '')
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('\0')) return false
  const normalised = normalize(trimmed)
  return !normalised.startsWith('..') && !normalised.includes(`..${'/'}`)
}

export async function validateRepository(input: ValidationInput): Promise<ValidationOutcome> {
  const started = Date.now()

  const urlCheck = await checkUrl(input.repoUrl)
  if (!urlCheck.ok) {
    return { status: 'REJECTED', detail: urlCheck.detail, durationMs: Date.now() - started }
  }

  if (input.buildMethod === 'DOCKERFILE') {
    const path = input.dockerfilePath ?? ''
    if (!isSafeRepoPath(path)) {
      return {
        status: 'REJECTED',
        detail: `'${path}' is not a valid path inside the repository.`,
        durationMs: Date.now() - started,
      }
    }
  }

  const host = hostFor(urlCheck.url)
  if (!host) {
    return { status: 'REJECTED', detail: 'Unsupported host.', durationMs: Date.now() - started }
  }

  const timeoutMs = await getNumber('submissions.clone_timeout_ms')

  return withTempDir(async (dir) => {
    const target = join(dir, 'repo')
    const clone = await shallowClone(urlCheck.normalised, target, timeoutMs)

    if (!clone.ok) {
      const reading = host.readFailure(clone.stderr, clone.timedOut)
      log.info('repository validation failed', {
        repoUrl: urlCheck.normalised, status: reading.status, timedOut: clone.timedOut,
      })
      return { ...reading, durationMs: Date.now() - started, normalisedUrl: urlCheck.normalised }
    }

    // E03-S03 acceptance 2: the declared Dockerfile must actually be there. Discovering this on
    // evaluation night would waste a probe slot and produce a "fails to build" the team could
    // fairly dispute.
    if (input.buildMethod === 'DOCKERFILE') {
      const relative = (input.dockerfilePath ?? '').trim().replace(/^\.\//, '')
      try {
        await access(join(target, relative))
      } catch {
        return {
          status: 'REJECTED' as const,
          detail:
            `The repository does not contain '${relative}'. Check the path you declared — it is ` +
            `relative to the repository root.`,
          durationMs: Date.now() - started,
          normalisedUrl: urlCheck.normalised,
        }
      }
    }

    /*
     * Tier 1 stops here (E45-S02, narrowed in E50): what a team could not be evaluated WITHOUT —
     * a reachable repository and a build declaration that points at something. "No README" and
     * "not enough code" used to refuse here too; they are now pre-flight findings the team is
     * told about and can fix, because an entry that exists must be evaluable even when it is
     * incomplete (Part V.4: nothing after intake is a gate).
     */
    const sha = await headSha(target)
    const committedAt = await headCommittedAt(target)

    log.info('repository validated', {
      repoUrl: urlCheck.normalised, commitSha: sha, durationMs: Date.now() - started,
    })

    return {
      status: 'VALID' as const,
      detail: 'The repository is public and was cloned successfully.',
      ...(sha !== null && { commitSha: sha }),
      ...(committedAt !== null && { headCommittedAt: committedAt }),
      normalisedUrl: urlCheck.normalised,
      durationMs: Date.now() - started,
    }
  })
}
