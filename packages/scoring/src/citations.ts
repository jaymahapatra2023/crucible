/**
 * Checking that a cited location is real (E13-S01, P4.1 clause 3).
 *
 * Every score and every discovery finding carries a path, a line range and an excerpt. The
 * schema enforces that those fields are present and well-formed. This is what enforces that
 * they are TRUE — the difference between a citation a reviewer could check and one they can.
 *
 * Without it, a model can cite `src/auth/session.ts:42-58` with a plausible invented excerpt and
 * the system will store it, render it, and reproduce it in the team's appeal packet. Every claim
 * Crucible makes about being defensible rests on that citation being real.
 *
 * Deterministic and model-free. The scan is already persisted in full; this is a lookup.
 */
import type { ScanResult, ScannedFile } from '@crucible/scanner'

export const CITATION_VERDICTS = ['VERIFIED', 'UNVERIFIABLE', 'CONTRADICTED'] as const
export type CitationVerdict = (typeof CITATION_VERDICTS)[number]

export interface CitationInput {
  path: string
  lineStart: number | null
  lineEnd: number | null
  excerpt: string
}

export interface CitationCheck {
  verdict: CitationVerdict
  /** Why, in terms a reviewer can act on. Shown in the UI and the appeal packet. */
  reason: string
}

export interface CitationOptions {
  /**
   * Lines of tolerance either side of the cited range.
   *
   * An off-by-two citation is a nuisance; treating it as fabrication would reject honest work
   * and, worse, would fail a criterion for a defect in our own line arithmetic.
   */
  drift: number
}

export const DEFAULT_CITATION_OPTIONS: CitationOptions = { drift: 3 }

/**
 * Text as it is compared.
 *
 * Whitespace is collapsed, because re-indenting a quote is not changing it. Case is deliberately
 * preserved: in source, `User` and `user` are different identifiers, and folding them would let a
 * near-miss pass as a match.
 *
 * Ellipsis markers are flattened here, but elision is handled by `matchesWithElision` — dropping
 * a marker and comparing the remainder would demand the two halves be adjacent.
 */
export function normaliseExcerpt(text: string): string {
  return text
    .replace(/…/g, ' ')
    .replace(/\.\.\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** An excerpt split on its ellipsis markers, each part normalised, empties dropped. */
export function elisionSegments(excerpt: string): string[] {
  return excerpt
    .split(/…|\.\.\./)
    .map((part) => normaliseExcerpt(part))
    .filter((part) => part !== '')
}

/**
 * Whether a quote appears in a body of text, allowing for elision.
 *
 * An ellipsis means "text omitted here", so a quote like `app.get("/x", ... handler)` must match
 * a line that has something in the gap. Deleting the marker and comparing the remainder would
 * demand the two halves be adjacent — the opposite of what the author meant — and rejecting an
 * honest trimmed quote would fail a criterion for a defect in our own matching.
 *
 * Segments must appear IN ORDER. That matters: without it a model could stitch fragments from
 * unrelated parts of a file and have the result pass.
 */
export function matchesWithElision(haystack: string, excerpt: string): boolean {
  const segments = elisionSegments(excerpt)
  if (segments.length === 0) return true

  let cursor = 0
  for (const segment of segments) {
    const at = haystack.indexOf(segment, cursor)
    if (at === -1) return false
    cursor = at + segment.length
  }
  return true
}

/**
 * The scanned file a path refers to.
 *
 * Tolerant of the leading `./` and `/` a model sometimes adds, because that is a formatting
 * habit rather than a claim about a different file.
 */
function findFile(scan: ScanResult, path: string): ScannedFile | undefined {
  const wanted = path.trim().replace(/^\.?\//, '')
  return scan.files.find((f) => f.path === path)
    ?? scan.files.find((f) => f.path.replace(/^\.?\//, '') === wanted)
}

const verified = (reason: string): CitationCheck => ({ verdict: 'VERIFIED', reason })
const unverifiable = (reason: string): CitationCheck => ({ verdict: 'UNVERIFIABLE', reason })
const contradicted = (reason: string): CitationCheck => ({ verdict: 'CONTRADICTED', reason })

/**
 * Check one citation against the scan it claims to come from.
 *
 * Three outcomes, and keeping them apart is the point of this function:
 *
 *  - `VERIFIED`     — the file is in the scan, the range is inside it, and the quoted text is
 *                     there.
 *  - `UNVERIFIABLE` — the file, or the part of it cited, is not among what the scan read. An
 *                     honest outcome, not a failure: the file budget legitimately stops short,
 *                     and a truncated file is recorded as such.
 *  - `CONTRADICTED` — the scan DOES cover this, and the citation does not hold.
 *
 * Collapsing the last two would either excuse fabrication or punish a budget that ran out.
 */
export function verifyCitation(
  citation: CitationInput,
  scan: ScanResult,
  options: CitationOptions = DEFAULT_CITATION_OPTIONS,
): CitationCheck {
  const file = findFile(scan, citation.path)
  if (!file) {
    // Whether an absent path is innocent turns entirely on whether the scan was truncated, and
    // the scan records that. If it read the whole repository, a path it does not hold is a path
    // that does not exist — and without this distinction a model could evade checking
    // altogether by citing only files outside the scan.
    return scan.budgetTruncated
      ? unverifiable(
          `'${citation.path}' was not among the ${scan.filesAnalysed} files the scan read, and `
          + `the scan was truncated by its file budget, so it may exist unread.`)
      : contradicted(
          `'${citation.path}' is not in the repository. The scan read all `
          + `${scan.filesTotal} files and this is not among them.`)
  }

  const lines = file.content.split('\n')
  const rangeCheck = checkRange(citation, file, lines.length)
  if (rangeCheck) return rangeCheck

  const wanted = citation.excerpt
  if (elisionSegments(wanted).length === 0) {
    // Nothing was quoted, so there is nothing to contradict. The range held, which is all this
    // citation ever claimed.
    return verified(`'${file.path}' is in the scan and the cited range is within it.`)
  }

  return checkExcerpt({ wanted, citation, file, lines, options })
}

/** Whether the cited line range falls inside the file the scan actually read. */
function checkRange(
  citation: CitationInput, file: ScannedFile, lineCount: number,
): CitationCheck | null {
  if (citation.lineStart === null) return null
  if (citation.lineStart <= lineCount) return null

  return file.truncated
    ? unverifiable(
        `'${file.path}' was truncated at ${lineCount} lines by the scan budget, so line `
        + `${citation.lineStart} was never read.`)
    : contradicted(
        `'${file.path}' has ${lineCount} lines; the citation points at line `
        + `${citation.lineStart}.`)
}

/** Whether the quoted text appears where it was said to appear. */
function checkExcerpt(args: {
  wanted: string
  citation: CitationInput
  file: ScannedFile
  lines: string[]
  options: CitationOptions
}): CitationCheck {
  const { wanted, citation, file, lines, options } = args
  const start = Math.max(0, (citation.lineStart ?? 1) - 1 - options.drift)
  const end = Math.min(lines.length, (citation.lineEnd ?? lines.length) + options.drift)
  const window = normaliseExcerpt(lines.slice(start, end).join('\n'))

  if (matchesWithElision(window, wanted)) {
    return verified(`The quoted text is at ${file.path}:${citation.lineStart ?? '?'}.`)
  }

  // Present, but not where the citation said. A reviewer following it lands on the wrong code,
  // which makes the citation useless even though nothing was invented.
  const whole = normaliseExcerpt(file.content)
  if (matchesWithElision(whole, wanted)) {
    return contradicted(
      `The quoted text appears in '${file.path}' but not within ${options.drift} lines of `
      + `${citation.lineStart}–${citation.lineEnd}.`)
  }

  // Not in the file at all. Truncation is the one innocent explanation, and it is checkable.
  return file.truncated
    ? unverifiable(
        `The quoted text is not in the ${lines.length} lines of '${file.path}' the scan read, `
        + `and the file was truncated.`)
    : contradicted(`The quoted text does not appear in '${file.path}'.`)
}

export interface CitationSummary {
  checks: CitationCheck[]
  verified: number
  unverifiable: number
  contradicted: number
  /** True when at least one citation is contradicted by source the scan actually holds. */
  anyContradicted: boolean
}

export function verifyCitations(
  citations: readonly CitationInput[],
  scan: ScanResult,
  options: CitationOptions = DEFAULT_CITATION_OPTIONS,
): CitationSummary {
  const checks = citations.map((c) => verifyCitation(c, scan, options))
  const count = (v: CitationVerdict) => checks.filter((c) => c.verdict === v).length
  const contradictedCount = count('CONTRADICTED')

  return {
    checks,
    verified: count('VERIFIED'),
    unverifiable: count('UNVERIFIABLE'),
    contradicted: contradictedCount,
    anyContradicted: contradictedCount > 0,
  }
}

/**
 * One line naming what was checked, for a reviewer and for the appeal packet.
 *
 * Worded so that `UNVERIFIABLE` reads as a statement about our reading rather than doubt about
 * the team — because that is what it is.
 */
export function describeCitations(summary: CitationSummary): string {
  const total = summary.checks.length
  if (total === 0) return 'No evidence was cited.'

  const parts: string[] = [`${summary.verified} of ${total} citations checked against the scan`]
  if (summary.unverifiable > 0) {
    parts.push(
      `${summary.unverifiable} could not be checked because the file was outside what the scan `
      + `read`)
  }
  if (summary.contradicted > 0) {
    parts.push(`${summary.contradicted} did not match the source`)
  }
  return `${parts.join('; ')}.`
}
