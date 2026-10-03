/**
 * Pure validation logic (E03-S02, E03-S03). No network, no database.
 */
import { describe, expect, it } from 'vitest'
import { isSafeRepoPath } from './repoValidation.js'
import { githubHost } from './hosts/githubHost.js'
import { gitlabHost } from './hosts/gitlabHost.js'
import { hostFor, knownHostnames, resetHosts } from './hosts/hostRegistry.js'

describe('isSafeRepoPath (P8.6 — a declaration must stay inside the repository)', () => {
  it.each(['Dockerfile', 'build/Dockerfile', './docker/Dockerfile', 'a/b/c/Dockerfile.prod'])(
    'accepts %s', (path) => expect(isSafeRepoPath(path)).toBe(true))

  it.each([
    '../../etc/passwd',
    '../Dockerfile',
    '/etc/passwd',
    '/Dockerfile',
    'a/../../b',
    '',
    '   ',
  ])('rejects %s', (path) => expect(isSafeRepoPath(path)).toBe(false))

  it('rejects a path containing a null byte', () => {
    expect(isSafeRepoPath('Dockerfile\0.txt')).toBe(false)
  })
})

describe('host registry (P1.5)', () => {
  it('resolves github and gitlab', () => {
    expect(hostFor(new URL('https://github.com/a/b'))?.name).toBe('github')
    expect(hostFor(new URL('https://gitlab.com/a/b'))?.name).toBe('gitlab')
    expect(hostFor(new URL('https://www.github.com/a/b'))?.name).toBe('github')
  })

  it('returns null for an unknown host', () => {
    expect(hostFor(new URL('https://bitbucket.org/a/b'))).toBeNull()
  })

  it('lists the hostnames it knows', () => {
    resetHosts()
    expect(knownHostnames()).toContain('github.com')
    expect(knownHostnames()).toContain('gitlab.com')
  })
})

describe('github URL normalisation', () => {
  it.each([
    ['https://github.com/team/project', 'https://github.com/team/project.git'],
    ['https://github.com/team/project.git', 'https://github.com/team/project.git'],
    ['https://github.com/team/project/', 'https://github.com/team/project.git'],
  ])('normalises %s', (input, expected) => {
    expect(githubHost.normalise(new URL(input))).toBe(expected)
  })

  it('rejects a URL that names no repository', () => {
    expect(githubHost.normalise(new URL('https://github.com/team'))).toBeNull()
  })
})

describe('gitlab URL normalisation', () => {
  it('supports nested groups', () => {
    expect(gitlabHost.normalise(new URL('https://gitlab.com/group/sub/project')))
      .toBe('https://gitlab.com/group/sub/project.git')
  })

  it('strips a tree path', () => {
    expect(gitlabHost.normalise(new URL('https://gitlab.com/group/project/-/tree/main')))
      .toBe('https://gitlab.com/group/project.git')
  })
})

describe('failure readings give a specific reason (E03-S02 acceptance 2)', () => {
  it('reads a timeout', () => {
    const r = githubHost.readFailure('', true)
    expect(r.status).toBe('UNREACHABLE')
    expect(r.detail).toMatch(/did not respond in time/)
  })

  it('reads an unresolvable host', () => {
    const r = githubHost.readFailure("fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com", false)
    expect(r.detail).toMatch(/could not be resolved/i)
  })

  it('names BOTH possibilities for GitHub, which cannot distinguish them anonymously', () => {
    // git reports a private repo and a nonexistent one identically over anonymous HTTPS.
    // Asserting "it is private" would send a team who mistyped the name after the wrong fix.
    const r = githubHost.readFailure(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled", false)
    expect(r.status).toBe('PRIVATE')
    expect(r.detail).toMatch(/either private or the URL is wrong/)
  })

  it('reads a GitLab 404 as a wrong path, not as private', () => {
    const r = gitlabHost.readFailure('remote: The project you were looking for could not be found (404)', false)
    expect(r.status).toBe('UNREACHABLE')
    expect(r.detail).toMatch(/does not exist at that path/)
  })

  it('reads a GitLab 403 as private', () => {
    const r = gitlabHost.readFailure('fatal: unable to access: The requested URL returned error: 403', false)
    expect(r.status).toBe('PRIVATE')
  })

  it('reads an empty repository as nothing to evaluate', () => {
    const r = githubHost.readFailure('warning: You appear to have cloned an empty repository.', false)
    expect(r.status).toBe('REJECTED')
    expect(r.detail).toMatch(/nothing to evaluate/)
  })

  it('never returns an empty reason', () => {
    for (const stderr of ['', 'something entirely unexpected']) {
      expect(githubHost.readFailure(stderr, false).detail.length).toBeGreaterThan(10)
      expect(gitlabHost.readFailure(stderr, false).detail.length).toBeGreaterThan(10)
    }
  })
})
