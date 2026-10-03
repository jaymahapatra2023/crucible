/**
 * Document text extraction (P1.3, ADR 0002).
 *
 * PDF, DOCX, Markdown and plain-text extraction was built for challenge briefs and lives in the
 * **challenges** module. Submissions now needs the same thing for the supporting documents a
 * team attaches (E36), and copying four extractors into a second module would be two
 * implementations of one capability that agree until one of them is fixed (P1.5 clause 6).
 *
 * **Unregistered returns UNSUPPORTED rather than throwing.** Extraction is best-effort by
 * construction — the challenges module already treats an unreadable document as a per-file
 * outcome rather than a failure — so a missing wire should degrade the same way a corrupt PDF
 * does, not take down the fetch that found it.
 */
import { createLogger } from '../logger.js'

const log = createLogger('platform', 'extractionPort')

export interface ExtractedText {
  ok: boolean
  text: string
  /** Why extraction produced nothing, for a reader who has to decide whether to re-attach. */
  detail: string
}

export interface ExtractionPort {
  /** Whether anything here can read this shape at all, before a byte is downloaded. */
  supports(mediaType: string, filename: string): boolean
  extract(input: { buffer: Buffer; filename: string; mediaType: string }): Promise<ExtractedText>
}

const unregistered: ExtractionPort = {
  supports: () => false,
  async extract() {
    log.warn('no extraction port is registered; documents cannot be read')
    return {
      ok: false, text: '',
      detail: 'No document extractor is available on this deployment.',
    }
  },
}

let impl: ExtractionPort = unregistered

export function registerExtractionPort(port: ExtractionPort): void {
  impl = port
}

/** Test seam — restores the unregistered implementation. */
export function resetExtractionPort(): void {
  impl = unregistered
}

export const extraction = (): ExtractionPort => impl
