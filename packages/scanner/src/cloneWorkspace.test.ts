/**
 * The clone checks out the commit it was told to (E50 review, E03-S04).
 *
 * Real git, a local repository: the property under test is that a decided commit is what ends
 * up on disk, not the branch's HEAD — the difference between evaluating what was locked at the
 * deadline and evaluating whatever was pushed afterwards.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { withClone } from './cloneWorkspace.js'

let repo: string | null = null
const git = (args: string[]) => execFileSync('git', args, { cwd: repo!, encoding: 'utf8' }).trim()

function makeRepo(): { first: string; second: string } {
  repo = mkdtempSync(join(tmpdir(), 'crucible-clone-test-'))
  git(['init', '--quiet', '--initial-branch=main'])
  git(['config', 'user.name', 'T'])
  git(['config', 'user.email', 't@test.local'])
  git(['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/app.js'), 'export const version = 1\n')
  git(['add', '-A']); git(['commit', '--quiet', '-m', 'first'])
  const first = git(['rev-parse', 'HEAD'])
  writeFileSync(join(repo, 'src/app.js'), 'export const version = 2 // pushed after the deadline\n')
  git(['add', '-A']); git(['commit', '--quiet', '-m', 'second'])
  const second = git(['rev-parse', 'HEAD'])
  return { first, second }
}

afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); repo = null })

describe('withClone', () => {
  it('checks out HEAD when no commit is decided', async () => {
    const { second } = makeRepo()
    const seen = await withClone(`file://${repo}`, { historyDepth: 1 }, async (c) => c.commitSha)
    expect(seen).toBe(second)
  })

  it('checks out the decided commit, not HEAD, even from a shallow clone', async () => {
    const { first, second } = makeRepo()
    const seen = await withClone(`file://${repo}`, { historyDepth: 1, commit: first }, async (c) => ({
      sha: c.commitSha, content: await readFile(join(c.path, 'src/app.js'), 'utf8'),
    }))
    expect(seen.sha).toBe(first)
    expect(seen.sha).not.toBe(second)
    expect(seen.content).toContain('version = 1')
  })

  it('fails rather than falling back to HEAD when the commit does not exist', async () => {
    makeRepo()
    await expect(withClone(`file://${repo}`, { historyDepth: 1, commit: 'f'.repeat(40) }, async () => 'ran'))
      .rejects.toThrow()
  })
})
