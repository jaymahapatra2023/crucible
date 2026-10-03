/**
 * Provenance analysis against real git history (E04-S06).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { analyseProvenance, flagProvenance, largestCommitShare, scanRepository } from '@crucible/scanner'
import {
  EVENT_WINDOW, inWindowRepo, makeGitRepo, outOfWindowRepo, type GitRepoFixture,
} from '../support/gitFixtures.js'

let repo: GitRepoFixture | null = null

afterEach(() => {
  repo?.cleanup()
  repo = null
})

const window = {
  startsAt: new Date(EVENT_WINDOW.startsAt),
  endsAt: new Date(EVENT_WINDOW.endsAt),
}

const THRESHOLDS = { maxOutOfWindowPct: 40, maxSingleCommitPct: 80 }

describe('reading history (acceptance 1)', () => {
  it('reports first and last commit, count and distinct authors', async () => {
    repo = makeGitRepo(inWindowRepo())
    const p = await analyseProvenance(repo.path, window)

    expect(p).not.toBeNull()
    expect(p!.totalCommits).toBe(3)
    expect(p!.distinctAuthors).toBe(2)
    expect(p!.authors).toContain('Second Author')
    expect(new Date(p!.firstCommitAt!).getTime())
      .toBeLessThan(new Date(p!.lastCommitAt!).getTime())
  })

  it('counts commits inside and outside the event window', async () => {
    repo = makeGitRepo(inWindowRepo())
    const inside = await analyseProvenance(repo.path, window)
    expect(inside!.commitsInWindow).toBe(3)
    expect(inside!.commitsOutOfWindow).toBe(0)

    repo.cleanup()
    repo = makeGitRepo(outOfWindowRepo())
    const outside = await analyseProvenance(repo.path, window)
    expect(outside!.commitsOutOfWindow).toBe(2)
    expect(outside!.commitsInWindow).toBe(1)
  })

  it('does not classify commits at all when no window is given', async () => {
    repo = makeGitRepo(inWindowRepo())
    const p = await analyseProvenance(repo.path)
    // Zeroes here mean "not classified", which is why the window is required to interpret them.
    expect(p!.commitsInWindow).toBe(0)
    expect(p!.commitsOutOfWindow).toBe(0)
    expect(p!.totalCommits).toBe(3)
  })

  it('computes the largest single commit as a share of additions', async () => {
    repo = makeGitRepo(outOfWindowRepo())
    const share = await largestCommitShare(repo.path)
    expect(share).toBeGreaterThan(40)
    expect(share).toBeLessThanOrEqual(100)
  })

  it('returns NULL for a directory with no git history, not zeroes', async () => {
    // Zeroes would read as "no activity"; null says "cannot be established", which is true.
    const { makeRepo } = await import('@crucible/scanner')
    const plain = makeRepo({ 'src/a.js': 'export const a = 1' })
    try {
      expect(await analyseProvenance(plain.path, window)).toBeNull()
    } finally {
      plain.cleanup()
    }
  })

  it('is included in a full scan', async () => {
    repo = makeGitRepo(inWindowRepo())
    const result = await scanRepository({ repoPath: repo.path, eventWindow: window })
    expect(result.provenance?.totalCommits).toBe(3)
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('flagging (acceptance 2 — flagged, never auto-excluded)', () => {
  it('raises no flag for work done inside the window', async () => {
    repo = makeGitRepo(inWindowRepo())
    const p = await analyseProvenance(repo.path, window)
    expect(flagProvenance(p, THRESHOLDS)).toEqual([])
  })

  it('flags substantially out-of-window work', async () => {
    repo = makeGitRepo(outOfWindowRepo())
    const flags = flagProvenance(await analyseProvenance(repo.path, window), THRESHOLDS)
    expect(flags.map((f) => f.code)).toContain('WORK_OUT_OF_WINDOW')
  })

  it('states the innocent explanation alongside the observation', async () => {
    repo = makeGitRepo(outOfWindowRepo())
    const flags = flagProvenance(await analyseProvenance(repo.path, window), THRESHOLDS)
    const flag = flags.find((f) => f.code === 'WORK_OUT_OF_WINDOW')
    // A flag that reads as an accusation invites acting on it without checking.
    expect(flag!.message).toMatch(/reused prior work|repository created before/i)
    expect(flag!.message).toMatch(/not by itself a reason to exclude/i)
  })

  it('flags a single commit carrying almost everything', () => {
    const flags = flagProvenance({
      firstCommitAt: '2026-06-06T00:00:00Z', lastCommitAt: '2026-06-07T00:00:00Z',
      totalCommits: 2, commitsInWindow: 2, commitsOutOfWindow: 0,
      distinctAuthors: 1, authors: ['A'], largestSingleCommitPct: 97, historyTruncated: false,
    }, THRESHOLDS)
    const flag = flags.find((f) => f.code === 'SINGLE_LARGE_COMMIT')
    expect(flag).toBeDefined()
    expect(flag!.message).toMatch(/also what committing existing work/i)
  })

  it('flags an absent history as unestablishable, not as suspicious', () => {
    const flags = flagProvenance(null, THRESHOLDS)
    expect(flags[0]?.code).toBe('NO_HISTORY')
    expect(flags[0]?.message).toMatch(/cannot be established/)
  })

  it('warns that a shallow clone makes the figures lower bounds (acceptance 4)', () => {
    const flags = flagProvenance({
      firstCommitAt: null, lastCommitAt: null, totalCommits: 1,
      commitsInWindow: 1, commitsOutOfWindow: 0, distinctAuthors: 1, authors: [],
      largestSingleCommitPct: 10, historyTruncated: true,
    }, THRESHOLDS)
    expect(flags.map((f) => f.code)).toContain('HISTORY_TRUNCATED')
  })

  it('respects configured thresholds (acceptance 3)', async () => {
    repo = makeGitRepo(outOfWindowRepo())
    const p = await analyseProvenance(repo.path, window)
    // Raise the threshold above the observed value and the flag disappears — the threshold is
    // the policy, and it lives in configuration.
    expect(flagProvenance(p, { maxOutOfWindowPct: 99, maxSingleCommitPct: 99 })
      .map((f) => f.code)).not.toContain('WORK_OUT_OF_WINDOW')
  })

  it('never returns an exclusion — flags are advisory by construction', async () => {
    repo = makeGitRepo(outOfWindowRepo())
    const flags = flagProvenance(await analyseProvenance(repo.path, window), THRESHOLDS)
    for (const flag of flags) {
      expect(flag).toHaveProperty('code')
      expect(flag).toHaveProperty('message')
      expect(flag).not.toHaveProperty('exclude')
      expect(flag).not.toHaveProperty('disqualified')
    }
  })
})
