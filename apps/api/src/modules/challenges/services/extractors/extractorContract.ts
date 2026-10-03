/**
 * The one contract every brief-format extractor implements (P1.5 clause 1).
 *
 * Brief format is a declared variant axis. Adding a format is one strategy file plus one line in
 * the registry — not a `switch (mediaType)` repeated across the upload path, the extraction job
 * and the re-extraction endpoint.
 */
import type { ExtractedSection } from '../../types/challengeTypes.js'

export interface ExtractionResult {
  text: string
  /** Section or page markers, so `source_ref` can name a location (E02-S02 acceptance 1). */
  sections: ExtractedSection[]
}

export interface BriefExtractor {
  /** Stable identifier, used in logs and in the registry. */
  readonly name: string
  /** Media types and file extensions this strategy claims. */
  readonly mediaTypes: readonly string[]
  readonly extensions: readonly string[]
  extract(buffer: Buffer, filename: string): Promise<ExtractionResult>
}

/**
 * Shared normalisation applied by every extractor, so downstream offsets mean the same thing
 * regardless of which format the text came from.
 */
export function normaliseText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    // Collapse runs of blank lines to at most one, so section offsets stay stable across
    // trivial formatting differences between exports of the same document.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/** Build a section list from headings found at known offsets. */
export function sectionsFromHeadings(
  text: string,
  headings: Array<{ label: string; offset: number }>,
): ExtractedSection[] {
  if (headings.length === 0) {
    return text.length > 0 ? [{ label: 'document', offset: 0, length: text.length }] : []
  }
  return headings.map((h, i) => ({
    label: h.label,
    offset: h.offset,
    length: (headings[i + 1]?.offset ?? text.length) - h.offset,
  }))
}
