/**
 * DOCX briefs.
 *
 * Converts to Markdown rather than raw text, because mammoth maps Word heading styles onto
 * Markdown headings — which preserves the section structure `source_ref` depends on. Extracting
 * plain text would flatten the document and leave nothing to cite.
 */
import mammoth from 'mammoth'

/**
 * `convertToMarkdown` exists at runtime but is missing from mammoth's published types. Narrowed
 * here, in one place, rather than casting at the call site — so if the types catch up, exactly
 * one declaration needs deleting.
 */
interface MammothMarkdown {
  convertToMarkdown(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>
}
import {
  normaliseText, sectionsFromHeadings,
  type BriefExtractor, type ExtractionResult,
} from './extractorContract.js'

/**
 * Mammoth escapes Markdown punctuation, so "documents." arrives as "documents\\.".
 *
 * That escaping is correct for rendering and wrong for us: this text is read by the criteria
 * generator and quoted in `source_ref`, where stray backslashes are noise at best and change a
 * quoted reference at worst. Heading markers survive because they sit at line start and are not
 * escaped.
 */
function unescapeMarkdown(markdown: string): string {
  return markdown.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1')
}

export const docxExtractor: BriefExtractor = {
  name: 'docx',
  mediaTypes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ],
  extensions: ['.docx'],

  async extract(buffer: Buffer): Promise<ExtractionResult> {
    const result = await (mammoth as unknown as MammothMarkdown).convertToMarkdown({ buffer })
    const text = normaliseText(unescapeMarkdown(result.value))

    const headings: Array<{ label: string; offset: number }> = []
    let offset = 0
    for (const line of text.split('\n')) {
      const m = /^(#{1,6})\s+(.+)$/.exec(line)
      if (m) headings.push({ label: `${m[1]} ${m[2]}`, offset })
      offset += line.length + 1
    }

    return { text, sections: sectionsFromHeadings(text, headings) }
  },
}
