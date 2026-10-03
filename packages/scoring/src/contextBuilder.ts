/**
 * Building the context a criterion is judged against (E06-S01).
 *
 * This is the direct fix for finding F3 — the upstream evaluators received a tech-stack *list*
 * and an `artifact_content` blob, and were therefore second-order passes over a summary. Here
 * the model receives real source, with real line numbers, chosen for the criterion it is
 * actually scoring.
 *
 * Four properties, each a stated acceptance criterion:
 *
 *  1. Context comes from the persisted scan **plus selected source excerpts with paths and line
 *     numbers**, so every score can cite a location.
 *  2. Selection is driven by the criterion's `evidence_spec`, not a fixed file list.
 *  3. The budget is explicit and recorded per call.
 *  4. When evidence cannot be located, that is an explicit `insufficient_evidence` outcome —
 *     **not a low score**.
 */
import type { Criterion } from '@crucible/rubric'
import type { ScanResult, ScannedFile } from '@crucible/scanner'
import { extractTerms, rankFiles, type FileRelevance, type TermHit } from './relevance.js'
import type { Excerpt, ScoringContext } from './types.js'

export interface ContextOptions {
  /** Total bytes of excerpt text. The dominant cost driver for a scoring run. */
  budgetBytes: number
  /** Lines of context kept either side of a matching line. */
  windowLines: number
  /** Most files to draw excerpts from, however much budget remains. */
  maxFiles: number
  /** Below this relevance, a file is not evidence — it merely shares a word. */
  minRelevance: number
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  budgetBytes: 60_000,
  windowLines: 12,
  maxFiles: 8,
  minRelevance: 12,
}

/**
 * What context selection actually needs from a criterion.
 *
 * Principles and standards (E06-S03) are evidence targets too, and acceptance 1 requires them to
 * use this same builder rather than a tech-stack list. Stating the requirement structurally lets
 * them do so without fabricating the anchors and sort orders a full `Criterion` would demand.
 */
export interface EvidenceTarget {
  criterionId: string
  name: string
  description: string
  evidenceSpec: string
  dimension?: Criterion['dimension']
  sourceRef?: string | undefined
}

export function buildContext(
  criterion: EvidenceTarget,
  scan: ScanResult,
  options: ContextOptions = DEFAULT_CONTEXT_OPTIONS,
): ScoringContext {
  // Driven by the evidence specification first: it says what a reader should be able to point
  // at, which is exactly the selection question.
  const terms = extractTerms(criterion.evidenceSpec, criterion.name, criterion.description)
  const ranked = rankFiles(scan.files, terms)
  const relevant = ranked.filter((f) => f.score >= options.minRelevance)

  const base = {
    criterionId: criterion.criterionId,
    criterionName: criterion.name,
    repoSummary: summariseRepo(scan),
    budgetLimitBytes: options.budgetBytes,
    filesSearched: scan.files.length,
  }

  if (relevant.length === 0) {
    // Nothing in the repository relates to what this criterion asks about. That is a statement
    // about our ability to check, not about the team's work (acceptance 4).
    return {
      ...base,
      excerpts: [],
      budgetUsedBytes: 0,
      budgetTruncated: false,
      insufficientEvidence: true,
      insufficientReason: buildInsufficientReason(criterion, scan, terms),
    }
  }

  const byFile = new Map(scan.files.map((f) => [f.path, f]))
  const excerpts: Excerpt[] = []
  let used = 0
  let truncated = false

  for (const file of relevant.slice(0, options.maxFiles)) {
    const scanned = byFile.get(file.path)
    if (!scanned) continue

    for (const excerpt of excerptsFrom(scanned, file, options.windowLines)) {
      const cost = excerpt.text.length
      if (used + cost > options.budgetBytes) {
        truncated = true
        break
      }
      excerpts.push(excerpt)
      used += cost
    }
    if (used >= options.budgetBytes) {
      truncated = true
      break
    }
  }

  if (excerpts.length === 0) {
    return {
      ...base,
      excerpts: [],
      budgetUsedBytes: 0,
      budgetTruncated: truncated,
      insufficientEvidence: true,
      insufficientReason:
        `Files mentioning this criterion's terms were found, but no excerpt fitted the ` +
        `${options.budgetBytes} byte context budget.`,
    }
  }

  return {
    ...base,
    // Ordered by location so the model reads a file's excerpts together and in sequence.
    excerpts: excerpts.sort((a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : a.lineStart - b.lineStart)),
    budgetUsedBytes: used,
    budgetTruncated: truncated,
    insufficientEvidence: false,
    insufficientReason: null,
  }
}

/**
 * Turn a file's matching lines into line-anchored windows.
 *
 * Windows, not whole files: a whole file spends the budget on lines nobody will cite, and a
 * model given 800 lines cannot be expected to quote the right three. Overlapping windows are
 * merged so an excerpt is never split mid-function for no reason.
 */
function excerptsFrom(
  scanned: ScannedFile, relevance: FileRelevance, windowLines: number,
): Excerpt[] {
  const lines = scanned.content.split('\n')
  const ranges = mergeRanges(
    relevance.hits.map((hit: TermHit) => ({
      start: Math.max(1, hit.line - windowLines),
      end: Math.min(lines.length, hit.line + windowLines),
      matched: hit.matched,
    })),
  )

  return ranges.map((range) => ({
    path: scanned.path,
    lineStart: range.start,
    lineEnd: range.end,
    text: lines.slice(range.start - 1, range.end).join('\n'),
    reason: `Mentions ${range.matched.slice(0, 5).join(', ')}`,
    relevance: relevance.score,
  }))
}

interface Range { start: number; end: number; matched: string[] }

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: Range[] = [{ ...sorted[0] as Range }]

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1] as Range
    if (range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
      last.matched = [...new Set([...last.matched, ...range.matched])]
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Explain *why* evidence is insufficient, specifically.
 *
 * "No evidence found" tells a reviewer nothing they can act on. Naming the terms searched for
 * and the coverage of the scan lets them judge whether the criterion is unscoreable, the
 * submission genuinely lacks the thing, or the file budget simply did not reach it.
 */
function buildInsufficientReason(
  criterion: EvidenceTarget, scan: ScanResult, terms: readonly string[],
): string {
  // Show the terms from the EVIDENCE SPEC first. `terms` is sorted alphabetically for
  // determinism, so slicing it would show a reviewer the least discriminating words — "check,
  // data, external" — instead of the ones that actually define the criterion.
  const specTerms = extractTerms(criterion.evidenceSpec)
  const shown = [...new Set([...specTerms, ...terms])].slice(0, 8)

  const parts = [
    `No file among the ${scan.files.length} read mentions anything this criterion asks about ` +
    `(searched for: ${shown.join(', ')}${terms.length > shown.length ? ', …' : ''}).`,
  ]

  if (scan.budgetTruncated) {
    // The honest caveat: the scanner may simply not have reached the relevant file.
    parts.push(
      `The scan read ${scan.filesAnalysed} of ${scan.filesTotal} files, so the relevant code ` +
      `may not have been read at all. Re-scanning at a greater depth would settle it.`,
    )
  } else {
    parts.push('The whole repository was read, so the code this criterion asks about is absent.')
  }

  if (criterion.dimension === 'CHALLENGE_FIDELITY' && criterion.sourceRef) {
    parts.push(`This criterion comes from ${criterion.sourceRef}.`)
  }
  return parts.join(' ')
}

/** Repository facts the model should not have to infer from excerpts. */
function summariseRepo(scan: ScanResult): string {
  const m = scan.metrics
  return [
    `Languages: ${m.languages.join(', ') || 'none detected'}.`,
    `${m.filesAnalysed} files read of ${scan.filesTotal} present` +
      `${scan.budgetTruncated ? ' (the file budget truncated the scan)' : ''}.`,
    `${m.totalLines} lines total, ${m.codeLines} of code.`,
    `Tests: ${m.hasTests ? `${m.testFileCount} test files` : 'none found'}.`,
    `CI configured: ${m.hasCi ? 'yes' : 'no'}. Dockerfile: ${m.hasDockerfile ? 'yes' : 'no'}.`,
    `Declared dependencies: ${m.dependencyCount}.`,
  ].join(' ')
}
