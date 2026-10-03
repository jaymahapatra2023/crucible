/**
 * Markdown and plain-text briefs.
 *
 * Markdown is the best case: headings are explicit, so `source_ref` can name a real section
 * rather than a page number that shifts when the document is re-exported.
 */
import {
  normaliseText, sectionsFromHeadings,
  type BriefExtractor, type ExtractionResult,
} from './extractorContract.js'

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/

function headingsOf(text: string): Array<{ label: string; offset: number }> {
  const headings: Array<{ label: string; offset: number }> = []
  let offset = 0
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const atx = ATX_HEADING.exec(line)
    if (atx) {
      headings.push({ label: `${'#'.repeat(atx[1]!.length)} ${atx[2]}`, offset })
    } else {
      // Setext headings: a line of === or --- underlining the previous line.
      const next = lines[i + 1]
      if (next && line.trim() !== '' && /^(=+|-{2,})\s*$/.test(next)) {
        headings.push({ label: line.trim(), offset })
      }
    }
    offset += line.length + 1
  }
  return headings
}

export const markdownExtractor: BriefExtractor = {
  name: 'markdown',
  mediaTypes: ['text/markdown', 'text/x-markdown'],
  extensions: ['.md', '.markdown', '.mdown'],

  async extract(buffer: Buffer): Promise<ExtractionResult> {
    const text = normaliseText(buffer.toString('utf8'))
    return { text, sections: sectionsFromHeadings(text, headingsOf(text)) }
  },
}

export const plainTextExtractor: BriefExtractor = {
  name: 'plaintext',
  mediaTypes: ['text/plain'],
  extensions: ['.txt', '.text'],

  async extract(buffer: Buffer): Promise<ExtractionResult> {
    const text = normaliseText(buffer.toString('utf8'))
    // Plain text has no reliable structure. Rather than guess at headings and produce
    // source_refs that point at the wrong place, treat numbered lines as the only markers we
    // are confident about, and fall back to one whole-document section.
    const numbered: Array<{ label: string; offset: number }> = []
    let offset = 0
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+(?:\.\d+)*)[.)]?\s+(\S.{0,80})/.exec(line)
      if (m) numbered.push({ label: `${m[1]} ${m[2]?.trim() ?? ''}`.trim(), offset })
      offset += line.length + 1
    }
    return { text, sections: sectionsFromHeadings(text, numbered) }
  },
}
