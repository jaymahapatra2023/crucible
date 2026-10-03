/**
 * Generators for real, valid PDF and DOCX bytes.
 *
 * The extractors are worth testing only against genuine binaries — a hand-written string would
 * prove nothing about whether pdfjs or mammoth can read what an organiser actually uploads.
 * These are generated rather than committed as binary blobs so the fixtures carry no
 * third-party document content and can be varied per test.
 */
import { deflateRawSync, crc32 } from 'node:zlib'

/** Build a minimal single-page PDF containing the given lines of text. */
export function makePdf(lines: string[], pages = 1): Buffer {
  const escape = (s: string): string => s.replace(/([\\()])/g, '\\$1')

  // Object ids are allocated up front: 1 catalog, 2 pages, then (page, content) per page, then
  // the font last. Deriving them inside the loop let page 2's id collide with page 1's font
  // reference, which produced a structurally invalid document.
  const pageId = (i: number): number => 3 + i * 2
  const contentId = (i: number): number => 4 + i * 2
  const fontId = 3 + pages * 2

  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages} >>\nendobj\n`,
  ]

  for (let p = 0; p < pages; p++) {
    const text = lines.map((l, i) =>
      `BT /F1 12 Tf 72 ${720 - i * 18} Td (${escape(pages > 1 ? `Page ${p + 1}: ${l}` : l)}) Tj ET`,
    ).join('\n')

    objects.push(
      `${pageId(p)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentId(p)} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`,
    )
    objects.push(
      `${contentId(p)} 0 obj\n<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream\nendobj\n`,
    )
  }
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`)

  // Assemble, tracking byte offsets for the cross-reference table.
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += obj
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1')
  const count = objects.length + 1
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

/** A PDF with no text content at all — stands in for a scanned document. */
export function makeEmptyPdf(): Buffer {
  return makePdf([])
}

interface ZipEntry { name: string; data: Buffer }

/** Minimal ZIP writer (deflate), sufficient for a valid .docx container. */
function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.data)
    const sum = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0, 6)           // flags
    local.writeUInt16LE(8, 8)           // method: deflate
    local.writeUInt16LE(0, 10)          // time
    local.writeUInt16LE(0, 12)          // date
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(0, 42)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + compressed.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, end])
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

export interface DocxBlock {
  /** 1–6 renders as a Word heading style, which mammoth maps to a Markdown heading. */
  heading?: number
  text: string
}

/** Build a minimal valid .docx from headings and paragraphs. */
export function makeDocx(blocks: DocxBlock[]): Buffer {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const paragraphs = blocks.map((b) => {
    const style = b.heading
      ? `<w:pPr><w:pStyle w:val="Heading${b.heading}"/></w:pPr>`
      : ''
    return `<w:p>${style}<w:r><w:t xml:space="preserve">${escape(b.text)}</w:t></w:r></w:p>`
  }).join('')

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs}</w:body>
</w:document>`

  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ])
}
