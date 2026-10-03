/**
 * Scan depth and the file budget (E04-S04).
 *
 * The budget is the scanner's most consequential hidden decision: it silently determines which
 * parts of a submission were read at all, and therefore what could be scored. The plan calls
 * this out as risk R6. So the profile is explicit, configurable, recorded on the scan, and any
 * truncation is surfaced rather than absorbed.
 */
import type { DepthProfile, ScanDepth } from './types.js'

export const DEPTH_PROFILES: Record<ScanDepth, DepthProfile> = {
  /** Enough for a typical hackathon entry read end to end. */
  standard: {
    maxFiles: 200,
    maxBytesPerFile: 48_000,
    maxTotalBytes: 3_000_000,
    maxDirDepth: 8,
  },
  /** For larger entries or monorepos. */
  deep: {
    maxFiles: 500,
    maxBytesPerFile: 64_000,
    maxTotalBytes: 8_000_000,
    maxDirDepth: 10,
  },
  /** Effectively everything. Slow; used when coverage matters more than time. */
  exhaustive: {
    maxFiles: 2_000,
    maxBytesPerFile: 96_000,
    maxTotalBytes: 32_000_000,
    maxDirDepth: 14,
  },
}

export const DEFAULT_DEPTH: ScanDepth = 'standard'

export function profileFor(depth: ScanDepth = DEFAULT_DEPTH): DepthProfile {
  return DEPTH_PROFILES[depth] ?? DEPTH_PROFILES[DEFAULT_DEPTH]
}

/**
 * Suggest a depth from a repository's size.
 *
 * Advisory only. The operator sets the depth for a run (E04-S04 acceptance 1), and the E11
 * dry run replaces these thresholds with measurements — guessing is what the dry run exists to
 * stop.
 */
export function recommendDepth(sourceFiles: number): ScanDepth {
  if (sourceFiles <= 150) return 'standard'
  if (sourceFiles <= 450) return 'deep'
  return 'exhaustive'
}

/**
 * How valuable a file is likely to be, for ordering under a budget.
 *
 * Ordering matters precisely because the budget bites: when only 200 of 900 files can be read,
 * *which* 200 decides what can be scored. Entry points, routes and configuration say more about
 * what a submission does than a deeply nested utility.
 *
 * Higher scores are read first.
 */
export function filePriority(relativePath: string): number {
  const lower = relativePath.toLowerCase()
  const depth = lower.split('/').length - 1
  let score = 100 - depth * 4

  // Things that describe the project as a whole.
  if (/^(readme|package\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|dockerfile|makefile)/i.test(relativePath)) {
    score += 60
  }
  // Entry points and wiring.
  if (/\b(main|index|app|server|cli|bootstrap|startup)\b/.test(lower)) score += 30
  // The parts that show what the submission actually does.
  if (/\b(route|router|controller|handler|endpoint|api|service|usecase|domain)\b/.test(lower)) score += 25
  if (/\b(model|schema|entity|repository|store|db|database|migration)\b/.test(lower)) score += 18
  if (/\b(config|settings|env)\b/.test(lower)) score += 12
  // Tests are worth reading — E06 scores whether they exist and what they assert — but they
  // describe the code rather than being it, so they rank below the implementation.
  if (/\b(test|spec|__tests__)\b/.test(lower)) score += 8
  // Generated or vendored code that survived the skip lists.
  if (/\b(generated|__generated__|\.pb\.|_pb2|swagger|openapi|vendored)\b/.test(lower)) score -= 40
  // Plurals matter: `examples/` and `fixtures/` are the usual directory names, and matching
  // only the singular meant the most common cases scored as ordinary source.
  if (/\b(examples?|samples?|fixtures?|mocks?|stubs?|demos?|scaffold(ing)?)\b/.test(lower)) score -= 15

  return score
}
