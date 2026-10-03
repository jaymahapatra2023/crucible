/**
 * The scanner's entry point (E04-S01).
 *
 * Takes a local checkout and returns a description of it. Deliberately not in scope:
 *
 *  - **No database.** The package has no `pg` dependency and never persists anything
 *    (acceptance 4); the caller decides what to store (E04-S05).
 *  - **No model calls.** Scanning is deterministic static analysis. Every judgement happens in
 *    E06 through the gateway, where it is configured, audited and carries evidence (P3.1).
 *  - **No cloning.** `withClone` is offered separately so the caller controls the lifetime of
 *    the working directory and the history depth it pays for.
 *
 * That leaves a package that can be run against any directory with no services at all, which is
 * what makes acceptance 5 — tests green with no database — true rather than aspirational.
 */
import { profileFor, DEFAULT_DEPTH } from './depthProfiles.js'
import { gatherFiles } from './fileGathering.js'
import { computeMetrics } from './codeMetrics.js'
import { getRepoStats } from './repoStats.js'
import { findMarkers } from './repoMarkers.js'
import { analyseProvenance } from './provenance.js'
import { readCommitSha, readHeadCommittedAt } from './cloneWorkspace.js'
import type { ScanInput, ScanResult } from './types.js'

export async function scanRepository(input: ScanInput): Promise<ScanResult> {
  const startedAt = Date.now()
  const depth = input.depth ?? DEFAULT_DEPTH

  const baseProfile = profileFor(depth)
  const profile = input.maxFiles === undefined
    ? baseProfile
    : { ...baseProfile, maxFiles: input.maxFiles }

  const stats = getRepoStats(input.repoPath)
  const gathered = gatherFiles(input.repoPath, profile)

  // Presence signals are read straight from the filesystem: the files that carry them are
  // excluded from the budget, so deriving them from what was gathered reported them absent.
  const markers = findMarkers(input.repoPath)
  const metrics = computeMetrics(gathered.files, markers)

  // Provenance is best-effort: a directory that is not a git checkout still scans fine, and
  // saying so is more useful than failing the whole scan.
  const provenance = await analyseProvenance(
    input.repoPath,
    input.eventWindow,
  ).catch(() => null)

  const [commitSha, headCommittedAt] = await Promise.all([
    readCommitSha(input.repoPath).catch(() => null),
    readHeadCommittedAt(input.repoPath).catch(() => null),
  ])

  return {
    commitSha,
    headCommittedAt,
    depth,
    stats,
    metrics,
    markers,
    files: gathered.files,
    provenance,
    filesAnalysed: gathered.files.length,
    filesTotal: gathered.candidatesFound,
    // Surfaced, never absorbed (E04-S04 acceptance 3, risk R6).
    budgetTruncated: gathered.budgetTruncated,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  }
}

/**
 * A scan result minus file contents.
 *
 * Useful for persistence and for logs: the contents are large, and a scan summary that can be
 * stored or printed without carrying a team's entire codebase is worth having.
 */
export function summarise(result: ScanResult): Omit<ScanResult, 'files'> & {
  files: Array<Omit<ScanResult['files'][number], 'content'>>
} {
  return {
    ...result,
    files: result.files.map(({ content: _content, ...rest }) => rest),
  }
}
