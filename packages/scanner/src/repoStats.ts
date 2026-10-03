/**
 * Repository shape, without reading file contents (E04-S01).
 *
 * Fast on purpose: this runs before the scan to size it, and E11 uses it to choose a depth
 * profile. Reading content here would double the cost of every scan for information the scan
 * itself is about to produce.
 */
import { statSync } from 'node:fs'
import { profileFor, recommendDepth } from './depthProfiles.js'
import { findCandidates } from './fileGathering.js'
import { languageOf } from './languages.js'
import type { RepoStats } from './types.js'
import { compareStrings } from './ordering.js'

export function getRepoStats(rootPath: string): RepoStats {
  try {
    if (!statSync(rootPath).isDirectory()) {
      throw new Error(`Not a directory: ${rootPath}`)
    }
  } catch (err) {
    throw new Error(`Repository path could not be read: ${rootPath}`, { cause: err })
  }

  // Enumerated at exhaustive depth so the *shape* is complete even when the scan will not be.
  // Sizing a repository with the budget that is about to truncate it would hide the truncation.
  const candidates = findCandidates(rootPath, profileFor('exhaustive'))

  const byLanguage: Record<string, number> = {}
  const directoryCounts: Record<string, number> = {}
  let totalBytes = 0

  for (const candidate of candidates) {
    totalBytes += candidate.bytes

    const language = languageOf(candidate.relativePath)
    byLanguage[language] = (byLanguage[language] ?? 0) + 1

    const segments = candidate.relativePath.split('/')
    const topDirectory = segments.length > 1 ? (segments[0] as string) : '.'
    directoryCounts[topDirectory] = (directoryCounts[topDirectory] ?? 0) + 1
  }

  const topDirectories = Object.entries(directoryCounts)
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .slice(0, 10)
    .map(([dir]) => dir)

  return {
    totalFiles: candidates.length,
    sourceFiles: candidates.length,
    totalBytes,
    byLanguage,
    topDirectories,
    recommendedDepth: recommendDepth(candidates.length),
  }
}

/** The dominant language by file count, or null when nothing was found. */
export function primaryLanguage(stats: RepoStats): string | null {
  const entries = Object.entries(stats.byLanguage)
    .filter(([lang]) => lang !== 'other' && lang !== 'markdown' && lang !== 'json')
  if (entries.length === 0) return null
  return entries.sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0]?.[0] ?? null
}
