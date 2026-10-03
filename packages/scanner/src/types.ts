/**
 * Scanner result types (E04-S01).
 *
 * The package is deliberately free of database and platform types: it takes a repository and
 * returns a description of it. Anything that needs persisting is the caller's business.
 */

export const SCAN_DEPTHS = ['standard', 'deep', 'exhaustive'] as const
export type ScanDepth = (typeof SCAN_DEPTHS)[number]

export interface DepthProfile {
  maxFiles: number
  maxBytesPerFile: number
  maxTotalBytes: number
  maxDirDepth: number
}

/** One file the scanner read, with enough context to cite it later. */
export interface ScannedFile {
  /** Repository-relative, POSIX separators. */
  path: string
  bytes: number
  lines: number
  language: string
  /** Content, truncated to the depth profile's per-file cap. */
  content: string
  /** True when the content was cut short — surfaced, never silent (E04-S04 acceptance 3). */
  truncated: boolean
}

export interface RepoStats {
  totalFiles: number
  /** Files that survived the skip lists — the ones that could be analysed. */
  sourceFiles: number
  totalBytes: number
  byLanguage: Record<string, number>
  topDirectories: string[]
  /** Depth the scanner would choose for a repository this size. */
  recommendedDepth: ScanDepth
}

export interface CodeMetrics {
  filesAnalysed: number
  totalLines: number
  codeLines: number
  commentLines: number
  blankLines: number
  /** Distinct languages with at least one analysed file. */
  languages: string[]
  /** Files over 400 lines — a rough structural signal, not a judgement. */
  longFiles: string[]
  maxFileLines: number
  averageFileLines: number
  hasTests: boolean
  testFileCount: number
  hasCi: boolean
  hasDockerfile: boolean
  hasReadme: boolean
  hasLockfile: boolean
  dependencyCount: number
}

/** Git history facts. Facts only — E06-S05 decides what they mean (E04-S06). */
export interface Provenance {
  firstCommitAt: string | null
  lastCommitAt: string | null
  totalCommits: number
  commitsInWindow: number
  commitsOutOfWindow: number
  distinctAuthors: number
  authors: string[]
  largestSingleCommitPct: number
  /** True when history was truncated by the clone depth, so counts are lower bounds. */
  historyTruncated: boolean
}

export interface ScanInput {
  /** A local checkout. The scanner never clones for you — see `cloneWorkspace`. */
  repoPath: string
  depth?: ScanDepth
  /** Event window, for provenance classification (E04-S06, OD-4). */
  eventWindow?: { startsAt: Date; endsAt: Date }
  /** Overrides the profile's file budget; used by calibration. */
  maxFiles?: number
}

export interface ScanResult {
  commitSha: string | null
  headCommittedAt: string | null
  depth: ScanDepth
  stats: RepoStats
  metrics: CodeMetrics
  /** Presence signals read directly from the filesystem, independent of the file budget. */
  markers: import('./repoMarkers.js').RepoMarkers
  files: ScannedFile[]
  provenance: Provenance | null
  /** Files the budget prevented the scanner from reading (E04-S04 acceptance 2 and 3). */
  filesAnalysed: number
  filesTotal: number
  budgetTruncated: boolean
  scannedAt: string
  durationMs: number
}
