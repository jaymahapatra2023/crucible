/**
 * AppError — the single error type services throw for conditions the API must report as a
 * specific code (P6.2). Route layer maps `code` to an HTTP status via `statusForCode`, so no
 * handler hand-picks a status.
 */
import { type ErrorCode, statusForCode } from '@crucible/contracts'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: unknown
  /** True when the caller may retry unchanged (transient upstream, throttling, timeout). */
  readonly retryable: boolean

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.status = statusForCode(code)
    this.details = options.details
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
    Error.captureStackTrace?.(this, AppError)
  }
}

const RETRYABLE_CODES = new Set<ErrorCode>([
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'TIMEOUT',
])

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/** Narrow an unknown thrown value to a message without losing non-Error throws. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** Convenience constructors for the codes used most, so call sites read as intent. */
export const notFound = (what: string, id?: string): AppError =>
  new AppError('NOT_FOUND', id ? `${what} '${id}' was not found.` : `${what} was not found.`)

export const validationFailed = (message: string, details?: unknown): AppError =>
  new AppError('VALIDATION_FAILED', message, { details })

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError('CONFLICT', message, { details })

export const forbidden = (message: string): AppError => new AppError('FORBIDDEN', message)
