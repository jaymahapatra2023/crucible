/**
 * The one registry that answers "which extractor handles this file" (P1.5 clauses 3 and 6).
 *
 * Every consumer — upload validation, the extraction job, the re-extract endpoint, and the
 * "which formats do we accept" API response — derives its answer from this single declaration.
 * Nothing re-branches on media type anywhere else.
 */
import { createLogger } from '../../../../lib/logger.js'
import type { BriefExtractor } from './extractorContract.js'
import { markdownExtractor, plainTextExtractor } from './markdownExtractor.js'
import { docxExtractor } from './docxExtractor.js'
import { pdfExtractor } from './pdfExtractor.js'

const log = createLogger('challenges', 'extractorRegistry')

/** Adding a format is one strategy file plus one line here. */
const EXTRACTORS: BriefExtractor[] = [
  markdownExtractor,
  plainTextExtractor,
  docxExtractor,
  pdfExtractor,
]

export function registerExtractor(extractor: BriefExtractor): void {
  EXTRACTORS.push(extractor)
  log.info('extractor registered', { extractor: extractor.name })
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? '' : filename.slice(dot).toLowerCase()
}

/**
 * Resolve by media type first, then by extension.
 *
 * Extension is a real fallback rather than a nicety: browsers routinely upload Markdown as
 * `application/octet-stream`, and rejecting a valid brief because of a content-type header would
 * be a support conversation on the day rather than a working upload.
 */
export function extractorFor(mediaType: string, filename: string): BriefExtractor | null {
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  const byType = EXTRACTORS.find((e) => e.mediaTypes.includes(type))
  if (byType) return byType

  const ext = extensionOf(filename)
  return EXTRACTORS.find((e) => e.extensions.includes(ext)) ?? null
}

export function isSupported(mediaType: string, filename: string): boolean {
  return extractorFor(mediaType, filename) !== null
}

/** Every accepted format — the single source for what the upload endpoint advertises. */
export function supportedFormats(): Array<{ name: string; mediaTypes: string[]; extensions: string[] }> {
  return EXTRACTORS.map((e) => ({
    name: e.name,
    mediaTypes: [...e.mediaTypes],
    extensions: [...e.extensions],
  }))
}

/** Test seam — restores the built-in set. */
export function resetExtractors(): void {
  EXTRACTORS.length = 0
  EXTRACTORS.push(markdownExtractor, plainTextExtractor, docxExtractor, pdfExtractor)
}
