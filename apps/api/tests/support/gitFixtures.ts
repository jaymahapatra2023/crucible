/**
 * Real git repositories for scan and provenance tests.
 *
 * Provenance reads actual git history — commit dates, authors, per-commit line counts — so a
 * fake would be testing the fake. These build genuine repositories with controlled history,
 * which is the only way to know the parsing is right.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface GitRepoFixture {
  path: string
  cleanup: () => void
}

export interface CommitSpec {
  message: string
  /** Files written before committing, relative to the repository root. */
  files: Record<string, string>
  /** Commit timestamp — used to place commits inside or outside the event window. */
  date: string
  authorName?: string
  authorEmail?: string
}

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: process.env['HOME'] ?? '/tmp',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  LC_ALL: 'C',
}

function git(repoPath: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): void {
  execFileSync('git', args, {
    cwd: repoPath,
    env: { ...GIT_ENV, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Create a repository with the given commit history, oldest first. */
export function makeGitRepo(commits: readonly CommitSpec[]): GitRepoFixture {
  const path = mkdtempSync(join(tmpdir(), 'crucible-git-fixture-'))

  git(path, ['init', '--quiet', '--initial-branch=main'])
  git(path, ['config', 'user.name', 'Fixture Author'])
  git(path, ['config', 'user.email', 'fixture@test.local'])
  git(path, ['config', 'commit.gpgsign', 'false'])

  for (const commit of commits) {
    for (const [relative, content] of Object.entries(commit.files)) {
      const full = join(path, relative)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
    git(path, ['add', '-A'])
    git(path, ['commit', '--quiet', '-m', commit.message], {
      GIT_AUTHOR_NAME: commit.authorName ?? 'Fixture Author',
      GIT_AUTHOR_EMAIL: commit.authorEmail ?? 'fixture@test.local',
      GIT_COMMITTER_NAME: commit.authorName ?? 'Fixture Author',
      GIT_COMMITTER_EMAIL: commit.authorEmail ?? 'fixture@test.local',
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
    })
  }

  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** A repository whose work sits entirely inside a hackathon weekend. */
export function inWindowRepo(): readonly CommitSpec[] {
  return [
    {
      message: 'Initial scaffold',
      date: '2026-06-06T10:00:00Z',
      files: { 'README.md': '# Entry\n', 'package.json': '{"name":"entry"}' },
    },
    {
      message: 'Add feed ingestion',
      date: '2026-06-06T15:00:00Z',
      files: { 'src/feed.js': 'export function connect() {\n  return true\n}\n' },
      authorName: 'Second Author', authorEmail: 'second@test.local',
    },
    {
      message: 'Add detection',
      date: '2026-06-07T11:00:00Z',
      files: { 'src/detect.js': 'export function detect(v) {\n  return v > 90\n}\n' },
    },
  ]
}

/** A repository where most of the work predates the event. */
export function outOfWindowRepo(): readonly CommitSpec[] {
  return [
    {
      message: 'Existing library',
      date: '2025-01-15T09:00:00Z',
      files: {
        'README.md': '# Prior work\n',
        'src/engine.js': Array.from({ length: 60 }, (_, i) => `export const f${i} = () => ${i}`).join('\n'),
      },
    },
    {
      message: 'More prior work',
      date: '2025-03-02T09:00:00Z',
      files: { 'src/more.js': Array.from({ length: 40 }, (_, i) => `export const g${i} = ${i}`).join('\n') },
    },
    {
      message: 'Hackathon tweak',
      date: '2026-06-06T12:00:00Z',
      files: { 'src/tweak.js': 'export const tweak = 1\n' },
    },
  ]
}

export const EVENT_WINDOW = {
  startsAt: '2026-06-06T00:00:00Z',
  endsAt: '2026-06-08T00:00:00Z',
}
