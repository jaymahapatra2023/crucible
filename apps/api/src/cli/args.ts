/**
 * Flag parsing and output for the operator CLIs.
 *
 * Deliberately small and hand-rolled rather than a dependency. These commands run on a laptop
 * minutes before an event, and the useful behaviour is to say exactly which flag is missing and
 * what the command expects — which a generic parser's error does not.
 */

export interface Args {
  command: string
  flag(name: string): string | null
  require(name: string, hint: string): string
  number(name: string, fallback: number): number
  has(name: string): boolean
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  const [command = '', ...rest] = argv
  const values = new Map<string, string>()
  const present = new Set<string>()

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    present.add(name)
    const next = rest[i + 1]
    // A flag followed by another flag is a switch, not a value.
    if (next !== undefined && !next.startsWith('--')) { values.set(name, next); i++ }
  }

  return {
    command,
    flag: (name) => values.get(name) ?? null,
    has: (name) => present.has(name),
    require(name, hint) {
      const value = values.get(name)
      if (value === undefined || value === '') {
        throw new UsageError(`--${name} is required: ${hint}`)
      }
      return value
    },
    number(name, fallback) {
      const raw = values.get(name)
      if (raw === undefined) return fallback
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number, not "${raw}".`)
      return parsed
    },
  }
}

/** A heading that survives being piped into a file, unlike colour. */
export const heading = (text: string): void => {
  process.stdout.write(`\n${text}\n${'─'.repeat(text.length)}\n`)
}

export const line = (text = ''): void => { process.stdout.write(`${text}\n`) }

/** A fixed-width table. Columns are padded to the widest cell so a terminal read stays aligned. */
export function table(header: readonly string[], rows: ReadonlyArray<readonly string[]>): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const render = (cells: readonly string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd()

  line(render(header))
  line(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const row of rows) line(render(row))
}

/**
 * Run a command, and fail the process on a usage error with the usage rather than a stack.
 *
 * A stack trace for "you forgot --set" teaches nothing and buries the one line that helps.
 */
export async function run(usage: string, main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`\n${err.message}\n\n${usage}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
