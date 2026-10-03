/**
 * Canonical error codes (P6.2).
 *
 * A code is a stable, machine-readable contract: clients branch on it, dashboards group by it,
 * and it never changes meaning. The human-readable `message` may be reworded freely; the code
 * may not. Each code maps to exactly one HTTP status so that P6.2's "status codes are
 * semantically correct" is a property of the table, not of each call site's judgement.
 */
export const ERROR_CODES = {
  // 400 — the request itself is malformed
  VALIDATION_FAILED: 400,
  MALFORMED_REQUEST: 400,
  // 401 / 403 — identity and permission
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  // 404 / 409 — resource state
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  IMMUTABLE_RESOURCE: 409,
  PRECONDITION_FAILED: 412,
  // 413 / 415 — payload
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  // 422 — semantically invalid but well-formed
  UNPROCESSABLE: 422,
  RUBRIC_NOT_FROZEN: 422,
  WINDOW_CLOSED: 422,
  QUALITY_GATE_FAILED: 422,
  // 429 — throttling
  RATE_LIMITED: 429,
  COST_CEILING_REACHED: 429,
  // 5xx — our fault
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_UNAVAILABLE: 503,
  TIMEOUT: 504,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** The HTTP status a code maps to. Single source of truth for route-layer status selection. */
export function statusForCode(code: ErrorCode): number {
  return ERROR_CODES[code]
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value)
}
