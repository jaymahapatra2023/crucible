/**
 * Reading a file an operator assembled by hand (E20).
 *
 * The cases here are the ones that actually arrive: a spreadsheet export with a byte-order mark,
 * a team name containing a comma, Windows line endings, and the unterminated quote that turns
 * the rest of the file into one field. Each must either parse correctly or fail naming a line.
 */
import { describe, expect, it } from 'vitest'
import { CsvError, headerIndex, parseCsv } from './csv.js'

describe('parsing', () => {
  it('reads a plain file', () => {
    expect(parseCsv('a,b\n1,2').map((r) => r.cells)).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps a comma inside a quoted field', () => {
    // "Smith, Jones & Co" is a team name, not two columns.
    expect(parseCsv('name,email\n"Smith, Jones",a@b.test')[1]!.cells)
      .toEqual(['Smith, Jones', 'a@b.test'])
  })

  it('unescapes a doubled quote', () => {
    expect(parseCsv('"She said ""no"""')[0]!.cells).toEqual(['She said "no"'])
  })

  it('handles Windows line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').map((r) => r.cells)).toEqual([['a', 'b'], ['1', '2']])
  })

  it('strips the byte-order mark Excel writes', () => {
    // Left in place it becomes part of the first header name, so the file is rejected for a
    // column that is visibly present.
    expect(parseCsv(`${'\ufeff'}team_name,contact_email\n`)[0]!.cells)
      .toEqual(['team_name', 'contact_email'])
  })

  it('skips blank lines rather than returning empty records', () => {
    expect(parseCsv('a\n\n\nb\n').map((r) => r.cells)).toEqual([['a'], ['b']])
  })

  it('reports the line a record starts on', () => {
    expect(parseCsv('h\na\nb').map((r) => r.line)).toEqual([1, 2, 3])
  })

  it('counts a multi-line quoted field toward later line numbers', () => {
    // Otherwise every line number after a wrapped field is wrong, and a line number that is
    // wrong is worse than no line number at all.
    const rows = parseCsv('h\n"two\nlines",x\nlast')
    expect(rows[2]!.cells).toEqual(['last'])
    expect(rows[2]!.line).toBe(4)
  })

  it('preserves an empty trailing cell', () => {
    expect(parseCsv('a,,c')[0]!.cells).toEqual(['a', '', 'c'])
  })

  it('REFUSES an unterminated quote, naming the line', () => {
    // The failure this parser exists to catch: everything after it silently becomes one field.
    try {
      parseCsv('a,b\n"never closed,x\nmore')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CsvError)
      expect((err as CsvError).line).toBe(2)
      expect((err as CsvError).message).toMatch(/never closed/)
    }
  })

  it('REFUSES a quote in the middle of an unquoted field', () => {
    expect(() => parseCsv('ab"cd')).toThrow(CsvError)
  })

  it('returns nothing for an empty file rather than one blank row', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n\n')).toEqual([])
  })
})

describe('matching the header', () => {
  const WANTED = {
    'team_name': ['team_name', 'team', 'name'],
    'contact_email': ['contact_email', 'email', 'contact'],
  } as const

  it('finds columns by their exact names', () => {
    expect(headerIndex(['team_name', 'contact_email'], WANTED))
      .toEqual({ team_name: 0, contact_email: 1 })
  })

  it('ignores case, spaces and underscores', () => {
    expect(headerIndex(['Team Name', 'CONTACT-EMAIL'], WANTED))
      .toEqual({ team_name: 0, contact_email: 1 })
  })

  it('accepts the shorter aliases people actually type', () => {
    expect(headerIndex(['Name', 'Email'], WANTED)).toEqual({ team_name: 0, contact_email: 1 })
  })

  it('does not care what order the columns are in', () => {
    expect(headerIndex(['email', 'team'], WANTED)).toEqual({ team_name: 1, contact_email: 0 })
  })

  it('tolerates extra columns it was not asked about', () => {
    expect(headerIndex(['notes', 'team', 'email'], WANTED))
      .toMatchObject({ team_name: 1, contact_email: 2 })
  })

  it('REFUSES a missing column, and quotes back what it actually read', () => {
    // "Missing contact_email" is a complaint; showing the header they wrote is actionable.
    try {
      headerIndex(['team_name', 'e-mail address'], WANTED)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as CsvError).message).toMatch(/missing contact_email/)
      expect((err as CsvError).message).toMatch(/e-mail address/)
    }
  })
})
