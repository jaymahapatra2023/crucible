/**
 * Brief extraction tests (E02-S02).
 *
 * Generated PDFs and DOCX files are real binaries, parsed by the same libraries production uses,
 * so these tests prove the extractors work rather than that a mock does.
 */
import { describe, expect, it } from 'vitest'
import { extractorFor, isSupported, supportedFormats, resetExtractors } from '../../src/modules/challenges/services/extractors/extractorRegistry.js'
import { makeDocx, makeEmptyPdf, makePdf } from '../support/documentFixtures.js'

const MEDIA = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const

async function extract(buffer: Buffer, mediaType: string, filename: string) {
  const ex = extractorFor(mediaType, filename)
  if (!ex) throw new Error(`no extractor for ${mediaType} / ${filename}`)
  return ex.extract(buffer, filename)
}

describe('registry resolution (P1.5)', () => {
  it('resolves by media type', () => {
    expect(extractorFor(MEDIA.md, 'brief.md')?.name).toBe('markdown')
    expect(extractorFor(MEDIA.pdf, 'brief.pdf')?.name).toBe('pdf')
    expect(extractorFor(MEDIA.docx, 'brief.docx')?.name).toBe('docx')
    expect(extractorFor(MEDIA.txt, 'brief.txt')?.name).toBe('plaintext')
  })

  it('falls back to extension when the browser sends a generic content type', () => {
    // Browsers routinely upload Markdown as application/octet-stream.
    expect(extractorFor('application/octet-stream', 'brief.md')?.name).toBe('markdown')
    expect(extractorFor('application/octet-stream', 'brief.pdf')?.name).toBe('pdf')
  })

  it('ignores content-type parameters', () => {
    expect(extractorFor('text/markdown; charset=utf-8', 'x.md')?.name).toBe('markdown')
  })

  it('returns null for a format nothing handles', () => {
    expect(extractorFor('image/png', 'brief.png')).toBeNull()
    expect(isSupported('application/zip', 'brief.zip')).toBe(false)
  })

  it('advertises exactly the formats E02-S01 acceptance 1 requires', () => {
    const names = supportedFormats().map((f) => f.name).sort()
    expect(names).toEqual(['docx', 'markdown', 'pdf', 'plaintext'])
    resetExtractors()
  })
})

describe('markdown', () => {
  const brief = [
    '# Challenge Alpha',
    '',
    'Build a telemetry pipeline.',
    '',
    '## 2.1 Ingestion',
    '',
    'Consume the provided feed.',
    '',
    '## 3.2 Detection',
    '',
    'Raise an alert on threshold breach.',
  ].join('\n')

  it('extracts the text', async () => {
    const out = await extract(Buffer.from(brief), MEDIA.md, 'brief.md')
    expect(out.text).toContain('Consume the provided feed.')
  })

  it('retains headings as section markers, so source_ref can name one', async () => {
    const out = await extract(Buffer.from(brief), MEDIA.md, 'brief.md')
    const labels = out.sections.map((s) => s.label)
    expect(labels).toContain('# Challenge Alpha')
    expect(labels).toContain('## 2.1 Ingestion')
    expect(labels).toContain('## 3.2 Detection')
  })

  it('gives each section an offset and length that locate it in the text', async () => {
    const out = await extract(Buffer.from(brief), MEDIA.md, 'brief.md')
    const detection = out.sections.find((s) => s.label === '## 3.2 Detection')
    expect(detection).toBeDefined()
    const slice = out.text.slice(detection!.offset, detection!.offset + detection!.length)
    expect(slice).toContain('Raise an alert on threshold breach.')
  })

  it('recognises setext headings', async () => {
    const out = await extract(Buffer.from('Overview\n========\n\nBody text.'), MEDIA.md, 'b.md')
    expect(out.sections.map((s) => s.label)).toContain('Overview')
  })

  it('covers the whole document when there are no headings', async () => {
    const out = await extract(Buffer.from('Just a paragraph.'), MEDIA.md, 'b.md')
    expect(out.sections).toHaveLength(1)
    expect(out.sections[0]?.label).toBe('document')
  })

  it('normalises line endings so the same brief hashes the same either way', async () => {
    const crlf = await extract(Buffer.from('# A\r\n\r\nBody\r\n'), MEDIA.md, 'b.md')
    const lf = await extract(Buffer.from('# A\n\nBody\n'), MEDIA.md, 'b.md')
    expect(crlf.text).toBe(lf.text)
  })
})

describe('plain text', () => {
  it('uses numbered clauses as markers when present', async () => {
    const text = '1. Scope\nBuild the thing.\n\n2.1 Ingestion\nConsume the feed.'
    const out = await extract(Buffer.from(text), MEDIA.txt, 'brief.txt')
    const labels = out.sections.map((s) => s.label)
    expect(labels.some((l) => l.startsWith('1 Scope'))).toBe(true)
    expect(labels.some((l) => l.startsWith('2.1 Ingestion'))).toBe(true)
  })

  it('falls back to one whole-document section rather than guessing', async () => {
    const out = await extract(Buffer.from('No structure here at all.'), MEDIA.txt, 'b.txt')
    expect(out.sections).toHaveLength(1)
  })
})

describe('pdf', () => {
  it('extracts text from a real PDF', async () => {
    const pdf = makePdf(['Challenge Beta', 'Extract the required fields.'])
    const out = await extract(pdf, MEDIA.pdf, 'brief.pdf')
    expect(out.text).toContain('Challenge Beta')
    expect(out.text).toContain('Extract the required fields.')
  })

  it('uses pages as section markers, which a reader can verify', async () => {
    const pdf = makePdf(['Opening line.'], 3)
    const out = await extract(pdf, MEDIA.pdf, 'brief.pdf')
    expect(out.sections.map((s) => s.label)).toEqual(['page 1', 'page 2', 'page 3'])
  })

  it('locates each page section within the extracted text', async () => {
    const pdf = makePdf(['Unique marker line.'], 2)
    const out = await extract(pdf, MEDIA.pdf, 'brief.pdf')
    const page2 = out.sections[1]!
    expect(out.text.slice(page2.offset, page2.offset + page2.length)).toContain('Page 2')
  })

  it('reports a scanned PDF as a specific failure, not an empty brief', async () => {
    // Silently extracting nothing would feed the generator an empty brief and produce criteria
    // grounded in nothing at all (risk R3).
    await expect(extract(makeEmptyPdf(), MEDIA.pdf, 'scan.pdf'))
      .rejects.toThrow(/no extractable text|most likely a scan/i)
  })

  it('fails loudly on a corrupt file rather than returning empty text', async () => {
    await expect(extract(Buffer.from('not a pdf at all'), MEDIA.pdf, 'broken.pdf')).rejects.toThrow()
  })
})

describe('docx', () => {
  const blocks = [
    { heading: 1, text: 'Challenge Gamma' },
    { text: 'Teams must process documents.' },
    { heading: 2, text: '1.4 Supported formats' },
    { text: 'Accept PDF and DOCX.' },
  ]

  it('extracts text from a real DOCX', async () => {
    const out = await extract(makeDocx(blocks), MEDIA.docx, 'brief.docx')
    expect(out.text).toContain('Teams must process documents.')
    expect(out.text).toContain('Accept PDF and DOCX.')
  })

  it('preserves Word heading styles as section markers', async () => {
    const out = await extract(makeDocx(blocks), MEDIA.docx, 'brief.docx')
    const labels = out.sections.map((s) => s.label)
    expect(labels.some((l) => l.includes('Challenge Gamma'))).toBe(true)
    expect(labels.some((l) => l.includes('Supported formats'))).toBe(true)
  })

  it('escapes markup in the source document safely', async () => {
    const out = await extract(
      makeDocx([{ text: 'Handle <script> and & correctly.' }]), MEDIA.docx, 'b.docx')
    expect(out.text).toContain('<script>')
  })

  it('fails loudly on a corrupt file', async () => {
    await expect(extract(Buffer.from('PK not really a zip'), MEDIA.docx, 'x.docx')).rejects.toThrow()
  })
})
