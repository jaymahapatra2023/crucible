/**
 * How Crucible writes CSV (P1.5 clause 6).
 *
 * Here rather than beside either caller because the API and the browser both write this format
 * and there is one definition of it. The cases below are the ones a wrong answer would corrupt
 * silently: an empty cell that must stay distinguishable from a recorded zero, and a team name
 * that a spreadsheet would execute on open.
 */
import { describe, expect, it } from 'vitest'
import { csvCell, csvDocument } from './csv.js'

describe('writing', () => {
  it('renders a header and rows, ending with a newline', () => {
    expect(csvDocument(['a', 'b'], [[1, 2], [3, 4]]))
      .toBe('"a","b"\n"1","2"\n"3","4"\n')
  })

  it('renders a value never recorded as EMPTY, not as "null" or 0 (P5.1)', () => {
    // A dimension that was not scored has no value. A zero in a spreadsheet column is
    // indistinguishable from a team that scored nothing.
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
    expect(csvCell(0)).toBe('"0"')
  })

  it('quotes EVERY cell, so an empty one is unambiguous', () => {
    // Five blank decision cells read as "","","","","" rather than as four stray commas.
    expect(csvDocument(['a', 'b', 'c'], [[null, '', 1]])).toContain('"","","1"')
  })

  it('escapes a quote by doubling it', () => {
    expect(csvCell('has"quote')).toBe('"has""quote"')
    expect(csvCell('{"1":1}')).toBe('"{""1"":1}"')
  })

  it('carries a comma or a newline inside the quotes', () => {
    expect(csvCell('has,comma')).toBe('"has,comma"')
    expect(csvCell('has\nnewline')).toBe('"has\nnewline"')
  })

  it('NEUTRALISES a cell a spreadsheet would execute', () => {
    // Team names and dismissal reasons are untrusted text typed by people outside this system.
    // A cell beginning = + - @ runs when the export is opened.
    for (const attack of ['=cmd|calc', '+1+1', '@SUM(A1)', '-1+cmd|calc']) {
      expect(csvCell(attack), attack).toBe(`"'${attack}"`)
    }
  })

  it('leaves a plain negative number alone', () => {
    // Otherwise every negative value in every export becomes text, to protect against nothing.
    expect(csvCell(-5)).toBe('"-5"')
    expect(csvCell('-12.5')).toBe('"-12.5"')
  })

  it('neutralises through the document writer, not only the cell helper', () => {
    expect(csvDocument(['team'], [['=cmd|calc']])).toContain(`"'=cmd|calc"`)
  })
})
