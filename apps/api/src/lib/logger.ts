/**
 * Structured JSON logging (P9.1).
 *
 * Every line is one JSON object carrying `timestamp`, `level`, `module`, `service`,
 * `correlationId` and whatever domain context the active scope holds. There is no
 * string-interpolation path — a logger that accepts `console.log(\`x ${y}\`)` produces lines
 * nothing can query, which defeats the point.
 *
 * Everything written passes through `redact()` first, so a secret cannot reach a log line even
 * inside a nested error cause or a stack trace (P8.3).
 */
import { currentContext } from './correlation.js'
import { redact } from './redact.js'

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type Level = (typeof LEVELS)[number]

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold: Level = 'info'
/** Test seam — when set, lines are pushed here instead of written to stdout. */
let sink: ((line: Record<string, unknown>) => void) | null = null

export function setLogLevel(level: Level): void {
  threshold = level
}

export function setLogSink(fn: ((line: Record<string, unknown>) => void) | null): void {
  sink = fn
}

export interface LogFields {
  [key: string]: unknown
  /** Present on LLM gateway lines — P3.2 requires callKey in every one of them. */
  callKey?: string
  err?: unknown
}

interface EmitInput {
  level: Level
  module: string
  service: string
  msg: string
  fields: LogFields
}

function emit({ level, module, service, msg, fields }: EmitInput): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[threshold]) return

  const ctx = currentContext()
  const line: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    module,
    service,
    msg: redact(msg),
  }
  if (ctx?.correlationId) line['correlationId'] = ctx.correlationId
  if (ctx?.actor) line['actor'] = ctx.actor
  if (ctx?.runId) line['runId'] = ctx.runId
  if (ctx?.submissionId) line['submissionId'] = ctx.submissionId

  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    line[k] = redact(v)
  }

  if (sink) {
    sink(line)
    return
  }
  const text = safeStringify(line)
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n')
  else process.stdout.write(text + '\n')
}

function safeStringify(line: Record<string, unknown>): string {
  try {
    return JSON.stringify(line)
  } catch {
    return JSON.stringify({
      timestamp: line['timestamp'],
      level: line['level'],
      module: line['module'],
      service: line['service'],
      msg: 'log serialization failed',
    })
  }
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Derive a logger for a narrower service within the same module. */
  child(service: string): Logger
}

/**
 * Create a logger bound to a module and service (P9.1 requires both on every line).
 * `module` is a bounded module from P1.1; `service` is the file or subsystem inside it.
 */
export function createLogger(module: string, service: string): Logger {
  return {
    debug: (msg, fields = {}) => emit({ level: 'debug', module, service, msg, fields }),
    info: (msg, fields = {}) => emit({ level: 'info', module, service, msg, fields }),
    warn: (msg, fields = {}) => emit({ level: 'warn', module, service, msg, fields }),
    error: (msg, fields = {}) => emit({ level: 'error', module, service, msg, fields }),
    child: (childService: string) => createLogger(module, `${service}.${childService}`),
  }
}
