/**
 * Reading a CSV file an operator supplied.
 *
 * Writing lives in `@crucible/contracts`, because the browser writes the same format and one
 * definition is the point. Reading is server-only and stays here.
 *
 * `csvDocument` and `csvCell` are re-exported so a caller needs one import for both directions.
 *
 * Written rather than taken from a dependency because the requirement is small and the failure
 * mode is not: this parses a file an organiser assembled by hand, minutes before a deadline, and
 * the useful behaviour is to say *which line* is wrong rather than to be lenient and guess.
 *
 * Follows RFC 4180 where it matters — quoted fields may contain commas, newlines and escaped
 * quotes — and is deliberately strict about the one thing spreadsheets get wrong: an unterminated
 * quote, which otherwise swallows the rest of the file into one enormous field.
 */
export { csvCell, csvDocument } from '@crucible/contracts'

export interface CsvRow {
  /** 1-based line where this record STARTS. A quoted field may span several lines. */
  line: number
  cells: string[]
}

export class CsvError extends Error {
  readonly line: number

  constructor(line: number, message: string) {
    super(message)
    this.name = 'CsvError'
    this.line = line
  }
}

/**
 * Parse CSV text into records.
 *
 * Blank lines are skipped rather than returned as empty records: a trailing newline is what every
 * editor adds and is not a row the operator meant to write.
 */
export function parseCsv(text: string): CsvRow[] {
  // A byte-order mark is what Excel writes by default, and left in place it becomes part of the
  // first header name — so the file is rejected for a column that is visibly present.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows: CsvRow[] = []
  let cells: string[] = []
  let field = ''
  let started = false
  let line = 1
  let rowLine = 1

  const endField = () => { cells.push(field); field = ''; started = true }
  const endRow = () => {
    endField()
    // A row of one empty cell is a blank line, not a record.
    if (!(cells.length === 1 && cells[0] === '')) rows.push({ line: rowLine, cells })
    cells = []
    started = false
    rowLine = line
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!

    if (ch === '"') {
      if (field !== '') {
        throw new CsvError(rowLine,
          'A quote appears in the middle of an unquoted field. Quote the whole field, or remove '
          + 'the quote.')
      }
      const quoted = readQuoted(input, i + 1, rowLine)
      field += quoted.value
      line += quoted.newlines
      i = quoted.next - 1
      continue
    }
    if (ch === ',') { endField(); continue }
    if (ch === '\r') continue
    if (ch === '\n') { line++; endRow(); continue }

    field += ch
  }

  if (field !== '' || started || cells.length > 0) endRow()

  return rows
}

/**
 * Read one quoted field, starting just after its opening quote.
 *
 * Split out so the main loop stays a flat state machine. It also puts the unterminated-quote
 * failure in one place — the case that otherwise swallows the rest of the file into one field,
 * and the only reason this parser is stricter than a split on commas.
 */
function readQuoted(
  input: string, start: number, rowLine: number,
): { value: string; next: number; newlines: number } {
  let value = ''
  let newlines = 0

  for (let i = start; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '"') {
      // A doubled quote is an escaped one; a single quote ends the field.
      if (input[i + 1] === '"') { value += '"'; i++; continue }
      return { value, next: i + 1, newlines }
    }
    if (ch === '\n') newlines++
    value += ch
  }

  throw new CsvError(rowLine,
    'A quoted field is never closed — there is an odd number of quotation marks. Everything '
    + 'after it was read as part of one value.')
}

/**
 * Match a header row against the columns required, tolerating case, spacing and underscores.
 *
 * Returns the index of each wanted column. Accepting `Team Name`, `team_name` and `TEAM NAME` as
 * the same thing costs three lines and removes the most common reason a file is rejected for
 * something the operator would swear was right.
 */
export function headerIndex(
  header: string[], wanted: Record<string, readonly string[]>,
): Record<string, number> {
  const normalise = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, '')
  const seen = header.map(normalise)

  const found: Record<string, number> = {}
  const missing: string[] = []

  for (const [name, aliases] of Object.entries(wanted)) {
    const index = seen.findIndex((h) => aliases.some((a) => normalise(a) === h))
    if (index === -1) missing.push(name) 
    else found[name] = index
  }

  if (missing.length > 0) {
    throw new CsvError(1,
      `The header row is missing ${missing.join(' and ')}. It reads `
      + `"${header.join(', ')}" and must name each required column.`)
  }
  return found
}
