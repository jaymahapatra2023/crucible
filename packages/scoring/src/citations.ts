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

export const CITATION_VERDICTS = [
  'VERIFIED', 'RELOCATED', 'UNVERIFIABLE', 'CONTRADICTED',
] as const
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
  /**
   * Where the quoted text actually is, when it was found somewhere other than the cited range.
   *
   * Set only for a RELOCATED citation. The caller stores these instead of the cited numbers, so
   * a reviewer following the evidence lands on the real code rather than on whatever happens to
   * sit at the line the model named.
   */
  corrected?: { lineStart: number; lineEnd: number }
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
 * Where a quoted excerpt actually starts and ends in a file.
 *
 * Walks a widening window from each line rather than searching the joined text, because the
 * answer has to be a LINE RANGE and a character offset into a normalised string cannot be mapped
 * back to one: normalisation collapses whitespace, so offsets no longer correspond to anything.
 *
 * Returns the FIRST match. A quote that appears twice is ambiguous and the first occurrence is
 * the honest answer to "where is this" — the alternative, reporting both, would put a reviewer
 * in the position of adjudicating our search rather than reading the team's code.
 */
function locate(lines: readonly string[], wanted: string): {
  lineStart: number; lineEnd: number
} | null {
  // A quote longer than this is not a citation, and the scan is bounded, so the bound is cheap.
  const MAX_SPAN = 40

  // Normalised once per line, not once per window. The naive version re-normalises the same
  // text forty times per starting line, which on a two-thousand-line file is eighty thousand
  // passes over growing strings — slow enough to matter inside a retry loop.
  const normalised = lines.map((l) => normaliseExcerpt(l))

  // Only lines that could begin the quote are worth widening from. The first segment's opening
  // word is a cheap, exact filter: a window starting anywhere else cannot match.
  const segments = elisionSegments(wanted)
  const opener = segments[0]?.split(' ')[0] ?? ''

  for (let from = 0; from < lines.length; from++) {
    if (opener !== '' && !normalised[from]!.includes(opener)) continue

    let window = ''
    for (let span = 1; span <= MAX_SPAN && from + span <= lines.length; span++) {
      window = span === 1 ? normalised[from]! : `${window} ${normalised[from + span - 1]!}`.trim()
      if (matchesWithElision(window, wanted)) {
        return { lineStart: from + 1, lineEnd: from + span }
      }
    }
  }
  return null
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
const relocated = (
  reason: string, corrected: { lineStart: number; lineEnd: number },
): CitationCheck => ({ verdict: 'RELOCATED', reason, corrected })
const unverifiable = (reason: string): CitationCheck => ({ verdict: 'UNVERIFIABLE', reason })
const contradicted = (reason: string): CitationCheck => ({ verdict: 'CONTRADICTED', reason })

/**
 * Check one citation against the scan it claims to come from.
 *
 * Three outcomes, and keeping them apart is the point of this function:
 *
 *  - `VERIFIED`     — the file is in the scan, the range is inside it, and the quoted text is
 *                     there.
 *  - `RELOCATED`    — the quoted text is in the cited FILE, verbatim, but not at the cited line.
 *                     Nothing was invented; the line arithmetic was wrong. Measured on the
 *                     calibration set, this was 301 of 344 rejections — and treating it as
 *                     fabrication threw away the whole response, retried it three times, and
 *                     then dropped the criterion, which silently RAISED the entry's score
 *                     because the composite renormalises over covered weight.
 *  - `UNVERIFIABLE` — the file, or the part of it cited, is not among what the scan read. An
 *                     honest outcome, not a failure: the file budget legitimately stops short,
 *                     and a truncated file is recorded as such.
 *  - `CONTRADICTED` — the scan DOES cover this, and the quoted text is nowhere in it. The only
 *                     one of the four that means the model made something up.
 *
 * Collapsing any two of these would either excuse fabrication, punish a budget that ran out, or
 * throw away a true quotation over an off-by-nine line number.
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
  const wanted = citation.excerpt

  if (elisionSegments(wanted).length === 0) {
    // Nothing was quoted, so the range is the entire claim and it has to hold on its own.
    const rangeCheck = checkRange(citation, file, lines.length)
    return rangeCheck
      ?? verified(`'${file.path}' is in the scan and the cited range is within it.`)
  }

  // The quotation is checked BEFORE the range, deliberately.
  //
  // A line number past the end of the file is the same mistake as a line number in the middle of
  // it: wrong arithmetic, not invention. Checking the range first made that case CONTRADICTED
  // however exact the quote was, which is the behaviour this whole change exists to correct.
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
  // Empty when the cited range starts past the end of the file; `slice` handles that, and the
  // quote then falls through to the whole-file search below rather than failing on the range.
  const window = normaliseExcerpt(lines.slice(start, end).join('\n'))

  if (start < lines.length && matchesWithElision(window, wanted)) {
    return verified(`The quoted text is at ${file.path}:${citation.lineStart ?? '?'}.`)
  }

  // Present in the file, but not where the citation said. Nothing was invented — so rather than
  // reject it, find where it really is and say so. The caller stores the corrected numbers, and
  // a reviewer following the evidence lands on the real code.
  const whole = normaliseExcerpt(file.content)
  if (matchesWithElision(whole, wanted)) {
    const at = locate(lines, wanted)
    return at
      ? relocated(
          `The quoted text is at ${file.path}:${at.lineStart}–${at.lineEnd}, not the cited `
          + `${citation.lineStart}–${citation.lineEnd}. The quotation is exact; the line `
          + `numbers were not.`, at)
      : relocated(
          `The quoted text is in '${file.path}' but spans lines this check could not pin down, `
          + `so the cited range ${citation.lineStart}–${citation.lineEnd} is left as given.`,
          { lineStart: citation.lineStart ?? 1, lineEnd: citation.lineEnd ?? 1 })
  }

  // Not in the file at all. Truncation is the one innocent explanation, and it is checkable.
  if (file.truncated) {
    return unverifiable(
      `The quoted text is not in the ${lines.length} lines of '${file.path}' the scan read, `
      + `and the file was truncated.`)
  }
  // Said together when both are wrong, so a reviewer is not left to discover the second fault
  // after chasing the first.
  const beyond = citation.lineStart !== null && citation.lineStart > lines.length
  return contradicted(
    `The quoted text does not appear in '${file.path}'.`
    + (beyond ? ` The file has ${lines.length} lines; the citation points at line `
        + `${citation.lineStart}.` : ''))
}

export interface CitationSummary {
  checks: CitationCheck[]
  verified: number
  /** Quoted correctly, cited at the wrong line. Counted apart so sloppiness stays visible. */
  relocated: number
  unverifiable: number
  contradicted: number
  /**
   * True when at least one citation quotes text the scan does not contain.
   *
   * Deliberately NOT true for a relocation. This is the flag that fails a whole response, and
   * the justification for being that strict is fabrication: a model that invented one citation
   * has not earned trust in the rest of itself. A wrong line number is not that.
   */
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
    relocated: count('RELOCATED'),
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
  if (summary.relocated > 0) {
    parts.push(
      `${summary.relocated} quoted the source exactly but gave the wrong line, corrected here`)
  }
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
