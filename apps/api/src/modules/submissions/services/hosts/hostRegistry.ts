/**
 * The one registry that answers "which host handles this URL" (P1.5 clauses 3 and 6).
 *
 * The allow-list itself is configuration (`submissions.allowed_hosts`), because which hosts an
 * event accepts is an organiser decision. The registry answers *how* to handle a host; the
 * config answers *whether* to accept it. Conflating the two would mean adding a host required a
 * deploy, and allowing one required a code change.
 */
import { createLogger } from '../../../../lib/logger.js'
import { githubHost } from './githubHost.js'
import { gitlabHost } from './gitlabHost.js'
import type { RepoHost } from './hostContract.js'

const log = createLogger('submissions', 'hostRegistry')

const HOSTS: RepoHost[] = [githubHost, gitlabHost]

export function registerHost(host: RepoHost): void {
  HOSTS.push(host)
  log.info('repo host registered', { host: host.name })
}

export function resetHosts(): void {
  HOSTS.length = 0
  HOSTS.push(githubHost, gitlabHost)
}

export function hostFor(url: URL): RepoHost | null {
  const hostname = url.hostname.toLowerCase()
  return HOSTS.find((h) => h.hosts.includes(hostname)) ?? null
}

export function knownHostnames(): string[] {
  return [...new Set(HOSTS.flatMap((h) => h.hosts))]
}
