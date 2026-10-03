/**
 * GitHub.
 *
 * GitHub deliberately returns the same "Repository not found" for a private repository and a
 * nonexistent one — it will not confirm that a private repo exists. So a team is told both
 * possibilities rather than being asserted at: telling them "it is private" when they simply
 * mistyped the name would send them chasing the wrong fix.
 */
import { commonFailureReading, type FailureReading, type RepoHost } from './hostContract.js'

export const githubHost: RepoHost = {
  name: 'github',
  hosts: ['github.com', 'www.github.com'],

  normalise(url: URL): string | null {
    const parts = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
    if (parts.length < 2) return null
    const [owner, repo] = parts
    if (!owner || !repo) return null
    return `https://github.com/${owner}/${repo}.git`
  },

  readFailure(stderr: string, timedOut: boolean): FailureReading {
    const s = stderr.toLowerCase()

    // Checked BEFORE the shared reading.
    //
    // Over anonymous HTTPS, GitHub asks for credentials for a private repository AND for one
    // that does not exist — it will not confirm a private repo's existence. git therefore
    // reports both as "terminal prompts disabled". The shared reading would state flatly that
    // the repository is private, which sends a team who simply mistyped the name after the
    // wrong fix. Both possibilities are named instead.
    const credentialPrompt =
      s.includes('terminal prompts disabled') ||
      s.includes('could not read username') ||
      s.includes('authentication failed')

    if (credentialPrompt || s.includes('repository not found') || s.includes('not found')) {
      return {
        status: 'PRIVATE',
        detail:
          'GitHub would not serve this repository anonymously. That means it is either private ' +
          'or the URL is wrong — GitHub answers the same way for both. Check the URL, and make ' +
          'the repository public before the deadline.',
      }
    }

    const common = commonFailureReading(stderr, timedOut)
    if (common) return common

    return {
      status: 'UNREACHABLE',
      detail: stderr === '' ? 'The repository could not be cloned.' : firstLine(stderr),
    }
  },
}

function firstLine(stderr: string): string {
  return stderr.split('\n').find((l) => l.trim() !== '')?.trim().slice(0, 300) ?? stderr.slice(0, 300)
}
