/**
 * Walking a repository under a budget (E04-S01, E04-S04).
 *
 * Three properties matter:
 *
 *  - **Deterministic.** Directory entries are sorted before use. Filesystem order is undefined,
 *    and a scanner whose file selection varied between runs would make E06-S06's double-run
 *    comparison meaningless (P4.4).
 *  - **Budgeted, and honest about it.** When the budget bites, the result says so and says how
 *    many files were left unread (E04-S04 acceptance 2 and 3).
 *  - **Priority-ordered.** Which files get read decides what can be scored, so the most
 *    informative ones are read first.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { filePriority } from './depthProfiles.js'
import { languageOf } from './languages.js'
import { shouldSkipDir, shouldSkipFile } from './skipLists.js'
import type { DepthProfile, ScannedFile } from './types.js'
import { compareStrings } from './ordering.js'

export interface GatherResult {
  files: ScannedFile[]
  /** Every candidate file found, whether or not the budget allowed reading it. */
  candidatesFound: number
  budgetTruncated: boolean
  totalBytesRead: number
}

interface Candidate {
  absolutePath: string
  relativePath: string
  bytes: number
  priority: number
}

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'))

/** Enumerate candidate files, deterministically, without reading any content. */
export function findCandidates(rootPath: string, profile: DepthProfile): Candidate[] {
  const candidates: Candidate[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > profile.maxDirDepth) return

    let entries: string[]
    try {
      // Sorted: filesystem order is undefined and must not leak into the result.
      entries = readdirSync(dir).sort()
    } catch {
      return
    }

    for (const entry of entries) {
      const absolutePath = join(dir, entry)
      let stats
      try {
        stats = statSync(absolutePath)
      } catch {
        continue
      }

      if (stats.isDirectory()) {
        if (shouldSkipDir(entry)) continue
        walk(absolutePath, depth + 1)
        continue
      }
      if (!stats.isFile()) continue
      if (shouldSkipFile(entry)) continue

      const relativePath = toPosix(relative(rootPath, absolutePath))
      candidates.push({
        absolutePath,
        relativePath,
        bytes: stats.size,
        priority: filePriority(relativePath),
      })
    }
  }

  walk(rootPath, 0)
  return candidates
}

/**
 * Read as much of the repository as the budget permits, most informative first.
 *
 * Ties are broken by path so the order is fully determined by the repository's content.
 */
export function gatherFiles(rootPath: string, profile: DepthProfile): GatherResult {
  const candidates = findCandidates(rootPath, profile)

  const ordered = [...candidates].sort((a, b) =>
    b.priority - a.priority || compareStrings(a.relativePath, b.relativePath))

  const files: ScannedFile[] = []
  let totalBytesRead = 0

  for (const candidate of ordered) {
    if (files.length >= profile.maxFiles) break
    if (totalBytesRead >= profile.maxTotalBytes) break

    let raw: string
    try {
      raw = readFileSync(candidate.absolutePath, 'utf8')
    } catch {
      // Unreadable or not valid UTF-8 — skip it rather than failing the scan.
      continue
    }
    if (looksBinary(raw)) continue

    const truncated = raw.length > profile.maxBytesPerFile
    const content = truncated ? raw.slice(0, profile.maxBytesPerFile) : raw

    files.push({
      path: candidate.relativePath,
      bytes: candidate.bytes,
      lines: countLines(content),
      language: languageOf(candidate.relativePath),
      content,
      truncated,
    })
    totalBytesRead += content.length
  }

  // Sorted by path for a stable result, independent of the priority order used to select them.
  files.sort((a, b) => compareStrings(a.path, b.path))

  return {
    files,
    candidatesFound: candidates.length,
    budgetTruncated: files.length < candidates.length,
    totalBytesRead,
  }
}

/** A NUL byte in the first few KB means this is not text, whatever its extension claims. */
function looksBinary(content: string): boolean {
  return content.slice(0, 4096).includes('\u0000')
}

export function countLines(content: string): number {
  if (content === '') return 0
  let lines = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++
  }
  return lines
}
