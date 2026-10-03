/**
 * The response envelope every Crucible endpoint uses (P6.2).
 *
 * Success: { data, meta? }.  Error: { error: { code, message, details? } }.
 * A 200 carrying `{ success: false }` is forbidden — failure is expressed by status + code.
 */
import type { ErrorCode } from './errorCodes.js'

export type PageMeta = {
  /** Real backend COUNT — never the length of a bounded fetch (P5.7). */
  total: number
  page: number
  pageSize: number
  /** True when `total` exceeds what this response carries, so the UI can say "showing X of Y". */
  truncated: boolean
}

/**
 * Response metadata. Page fields are the common case; a handler may add its own keys (the window
 * a metrics query covered, for instance) without a bespoke envelope per endpoint.
 */
export type Meta = Partial<PageMeta> & Record<string, unknown>

export interface ApiSuccess<T> {
  data: T
  meta?: Meta
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    message: string
    details?: unknown
  }
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody

export function ok<T>(data: T, meta?: Meta): ApiSuccess<T> {
  return meta === undefined ? { data } : { data, meta }
}

export function fail(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } }
}

export function isApiError<T>(r: ApiResponse<T>): r is ApiErrorBody {
  return typeof r === 'object' && r !== null && 'error' in r
}

/** Build page metadata from a real total and the page actually returned (P5.7 / P6.3). */
export function pageMeta(total: number, page: number, pageSize: number): PageMeta {
  return { total, page, pageSize, truncated: total > page * pageSize }
}
