/**
 * Git history analysis (E04-S06).
 *
 * This produces **facts, never verdicts**. The story is explicit that a submission with
 * substantial out-of-window work is *flagged, never auto-excluded* (acceptance 2), and the
 * reasons are good ones: a team may legitimately reuse their own prior library, a commit
 * timestamp is trivially forgeable, and a squashed history looks identical to a single
 * copy-paste. So this module reports what the history says and stops there.
 *
 * Thresholds live in configuration (acceptance 3) and are applied by the caller.
 */
import { isShallow, readLog, readNumstat } from './cloneWorkspace.js'
import type { Provenance } from './types.js'

const RECORD = '\u001e'

/**
 * Read history facts from a checkout.
 *
 * Returns null when the repository has no readable history at all — an empty repository or a
 * download rather than a clone. Null is the honest answer; zeroes would read as "no activity",
 * which is a different claim.
 */
export async function analyseProvenance(
  repoPath: string,
  eventWindow?: { startsAt: Date; endsAt: Date },
): Promise<Provenance | null> {
  const log = await readLog(repoPath, `%H${RECORD}%cI${RECORD}%aE${RECORD}%aN`)
  if (log === null || log.trim() === '') return null

  const commits = log.split('\n')
    .map((line) => line.split(RECORD))
    .filter((parts) => parts.length >= 4)
    .map((parts) => ({
      sha: parts[0] as string,
      committedAt: new Date(parts[1] as string),
      authorEmail: (parts[2] as string).toLowerCase(),
      authorName: parts[3] as string,
    }))
    .filter((c) => !Number.isNaN(c.committedAt.getTime()))

  if (commits.length === 0) return null

  // `git log` is newest-first.
  const newest = commits[0]
  const oldest = commits[commits.length - 1]

  let commitsInWindow = 0
  let commitsOutOfWindow = 0
  if (eventWindow) {
    for (const commit of commits) {
      const inside = commit.committedAt >= eventWindow.startsAt &&
        commit.committedAt <= eventWindow.endsAt
      if (inside) commitsInWindow++
      else commitsOutOfWindow++
    }
  }

  const authorsByEmail = new Map<string, string>()
  for (const commit of commits) authorsByEmail.set(commit.authorEmail, commit.authorName)

  return {
    firstCommitAt: oldest?.committedAt.toISOString() ?? null,
    lastCommitAt: newest?.committedAt.toISOString() ?? null,
    totalCommits: commits.length,
    commitsInWindow,
    commitsOutOfWindow,
    distinctAuthors: authorsByEmail.size,
    authors: [...authorsByEmail.values()].sort(),
    largestSingleCommitPct: await largestCommitShare(repoPath),
    historyTruncated: await isShallow(repoPath),
  }
}

/**
 * The largest single commit as a share of all additions.
 *
 * A single commit carrying nearly the whole codebase is what an initial dump looks like — and
 * also what a legitimate `git init` of existing work looks like. Reported as a number for a
 * human to interpret, which is exactly the point of acceptance 2.
 */
export async function largestCommitShare(repoPath: string): Promise<number> {
  const numstat = await readNumstat(repoPath)
  if (!numstat) return 0

  const additionsPerCommit: number[] = []
  let current = 0
  let seenCommit = false

  for (const line of numstat.split('\n')) {
    if (line.startsWith('__commit__')) {
      if (seenCommit) additionsPerCommit.push(current)
      current = 0
      seenCommit = true
      continue
    }
    const match = /^(\d+)\t(\d+)\t/.exec(line)
    if (match?.[1]) current += Number(match[1])
  }
  if (seenCommit) additionsPerCommit.push(current)

  const total = additionsPerCommit.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  return Math.round((Math.max(...additionsPerCommit) / total) * 1000) / 10
}

export interface ProvenanceThresholds {
  /** Share of commits outside the window above which the submission is flagged. */
  maxOutOfWindowPct: number
  /** Share of additions in one commit above which the submission is flagged. */
  maxSingleCommitPct: number
}

export interface ProvenanceFlag {
  code: 'WORK_OUT_OF_WINDOW' | 'SINGLE_LARGE_COMMIT' | 'NO_HISTORY' | 'HISTORY_TRUNCATED'
  /** Plain language, for a reviewer rather than a log (P5.4, E08-S03 acceptance 2). */
  message: string
}

/**
 * Turn facts into flags for human review.
 *
 * Every flag says what was observed and what it might mean — including the innocent
 * explanation. A flag that reads as an accusation invites a reviewer to act on it without
 * checking, which is precisely what "flagged, never auto-excluded" is meant to prevent.
 */
export function flagProvenance(
  provenance: Provenance | null,
  thresholds: ProvenanceThresholds,
): ProvenanceFlag[] {
  if (!provenance) {
    return [{
      code: 'NO_HISTORY',
      message:
        'This submission has no readable git history, so when the work was done cannot be ' +
        'established. That is common when a repository is uploaded rather than pushed.',
    }]
  }

  const flags: ProvenanceFlag[] = []

  if (provenance.historyTruncated) {
    flags.push({
      code: 'HISTORY_TRUNCATED',
      message:
        'History was shallow-cloned, so commit counts are lower bounds and the out-of-window ' +
        'figure cannot be relied on.',
    })
  }

  const total = provenance.commitsInWindow + provenance.commitsOutOfWindow
  if (total > 0) {
    const outPct = (provenance.commitsOutOfWindow / total) * 100
    if (outPct > thresholds.maxOutOfWindowPct) {
      flags.push({
        code: 'WORK_OUT_OF_WINDOW',
        message:
          `${outPct.toFixed(0)}% of commits fall outside the event window ` +
          `(${provenance.commitsOutOfWindow} of ${total}). This may be reused prior work, a ` +
          `repository created before the event, or incorrect commit timestamps — it needs a ` +
          `person to look, and is not by itself a reason to exclude.`,
      })
    }
  }

  if (provenance.largestSingleCommitPct > thresholds.maxSingleCommitPct) {
    flags.push({
      code: 'SINGLE_LARGE_COMMIT',
      message:
        `One commit contains ${provenance.largestSingleCommitPct}% of all added lines. That is ` +
        `what an initial import looks like — and also what committing existing work into a new ` +
        `repository looks like.`,
    })
  }

  return flags
}
