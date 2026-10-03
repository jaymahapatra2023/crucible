/**
 * GitLab.
 *
 * GitLab distinguishes "project not found" from an authentication prompt, so the reading can be
 * more precise than GitHub's.
 */
import { commonFailureReading, type FailureReading, type RepoHost } from './hostContract.js'

export const gitlabHost: RepoHost = {
  name: 'gitlab',
  hosts: ['gitlab.com', 'www.gitlab.com'],

  normalise(url: URL): string | null {
    const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/-\/tree\/.*$/, '')
    const parts = path.split('/').filter(Boolean)
    // GitLab supports nested groups, so anything from group/project downwards is valid.
    if (parts.length < 2) return null
    return `https://gitlab.com/${parts.join('/')}.git`
  },

  readFailure(stderr: string, timedOut: boolean): FailureReading {
    // Host-specific readings take precedence over the shared ones (P1.5: the base is the
    // default, the variant overrides what it knows better).
    const s = stderr.toLowerCase()
    if (s.includes('project not found') || s.includes('404')) {
      return {
        status: 'UNREACHABLE',
        detail: 'GitLab reports the project does not exist at that path. Check the URL.',
      }
    }
    if (s.includes('403') || s.includes('access denied')) {
      return {
        status: 'PRIVATE',
        detail: 'GitLab refused access, so the project is private. Make it public before the deadline.',
      }
    }

    const common = commonFailureReading(stderr, timedOut)
    if (common) return common

    return {
      status: 'UNREACHABLE',
      detail: stderr === '' ? 'The repository could not be cloned.' : stderr.split('\n')[0]?.slice(0, 300) ?? '',
    }
  },
}
