/**
 * How Crucible writes CSV — the one definition, shared by the API and the browser (P1.5 clause 6).
 *
 * It lives here rather than in either of them because both write the same file. Every operator
 * export is rendered on the server, but the bulk token file cannot be: it carries plaintexts
 * that exist only in the response that issued them, so the browser builds it from what it holds.
 * Two writers would be two formats, drifting apart for as long as nobody compared them.
 *
 * **Every cell is quoted, always.** It costs a few bytes and removes a whole class of question —
 * whether this particular value needed it, whether an empty cell is empty or missing, whether a
 * spreadsheet will guess a type. Five blank decision cells read unambiguously as `"","","","",""`.
 */

/** Render a header and rows, newline-separated, ending with one. */
export function csvDocument(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return `${lines.join('\n')}\n`
}

/**
 * One cell: neutralised if a spreadsheet would execute it, then quoted.
 *
 * Team names, validation details and dismissal reasons are untrusted text typed by people
 * outside this system. A cell beginning `=`, `+`, `-` or `@` runs when the export is opened,
 * which turns "download the submissions" into code execution on an organiser's laptop.
 *
 * A plain number is exempt: `-5` is a negative number in every export that has one, and
 * rendering it as `'-5` would make the column text to protect against nothing. `-1+cmd|calc` is
 * not a number, so it is still neutralised.
 */
export function csvCell(value: unknown): string {
  // Never the strings "null" or "0": a value that was never recorded is not a value of zero (P5.1).
  if (value === null || value === undefined) return '""'

  const text = String(value)
  const safe = /^[=+\-@\t\r]/.test(text) && !isPlainNumber(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

const isPlainNumber = (text: string): boolean =>
  text.trim() !== '' && Number.isFinite(Number(text))
