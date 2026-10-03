/**
 * PDF briefs.
 *
 * Text is extracted per page and pages become the section markers, because a PDF has no reliable
 * heading structure — "page 4" is the most precise citation a reader can verify.
 *
 * A PDF that yields no text is almost always a scan. That is reported as a specific failure
 * rather than an empty extraction, because an empty brief would otherwise flow silently into the
 * generator and produce criteria grounded in nothing (risk R3).
 */
import type { BriefExtractor, ExtractionResult } from './extractorContract.js'
import type { ExtractedSection } from '../../types/challengeTypes.js'

interface PdfTextItem { str?: string }

export const pdfExtractor: BriefExtractor = {
  name: 'pdf',
  mediaTypes: ['application/pdf'],
  extensions: ['.pdf'],

  async extract(buffer: Buffer): Promise<ExtractionResult> {
    // Imported lazily: pdfjs is large, and most challenges never upload a PDF.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

    // The loading task, not the document, owns the worker — so it is what must be destroyed.
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // No fonts or images are needed for text extraction, and disabling font loading avoids
      // pulling in machinery that has no place in a server process.
      useSystemFonts: false,
    })
    const doc = await loadingTask.promise

    const pageTexts: string[] = []

    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()
        pageTexts.push(
          (content.items as PdfTextItem[])
            .map((i) => i.str ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        page.cleanup()
      }
    } finally {
      await loadingTask.destroy()
    }

    // Offsets are computed against the assembled string itself. Computing them first and
    // normalising afterwards shifts every one of them, which would make each `source_ref` cite
    // the wrong part of the brief — silently, and in a way only a careful reader would catch.
    const SEPARATOR = '\n\n'
    const sections: ExtractedSection[] = []
    let offset = 0
    for (let i = 0; i < pageTexts.length; i++) {
      const block = pageTexts[i] as string
      sections.push({ label: `page ${i + 1}`, offset, length: block.length })
      offset += block.length + SEPARATOR.length
    }
    const text = pageTexts.join(SEPARATOR)

    if (text.trim() === '') {
      throw new Error(
        'The PDF contains no extractable text. It is most likely a scan; supply a text-based ' +
          'PDF, or upload the brief as Markdown or DOCX.',
      )
    }
    return { text, sections }
  },
}
