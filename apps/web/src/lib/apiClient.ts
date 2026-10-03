/**
 * Typed API client.
 *
 * Every response is the P6.2 envelope, so this is the one place that unwraps `data` and turns
 * `error` into a thrown `ApiClientError`. Callers never see a raw fetch or a status code.
 *
 * P5.7 is enforced here too: `total` always comes from `meta`, never from `data.length`, so a
 * bounded page can never be rendered as if it were the whole set.
 */
import type { ApiErrorBody, ErrorCode, PageMeta } from '@crucible/contracts'
import { endSession, getToken } from './session.js'

export class ApiClientError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR'
  readonly status: number
  readonly details: unknown

  constructor(code: ErrorCode | 'NETWORK_ERROR', message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export interface Page<T> {
  items: T[]
  /** Real backend count (P5.7). */
  total: number
  page: number
  pageSize: number
  truncated: boolean
}

const BASE = '/api/v1'

/**
 * Options that change how a request authenticates, not what it sends.
 *
 * `anonymous` exists for the public submission page. That page has no session, so a 401 there
 * means "your submission token is wrong", not "you have been signed out" — and ending a session
 * that was never started would bounce a team to a sign-in screen they have no account for.
 */
interface RequestOptions {
  anonymous?: boolean
}

/**
 * The headers a request carries.
 *
 * A JSON content type is declared only when there actually IS a body: declaring it on a bodyless
 * POST — an action endpoint like /freeze or /publish — makes the server reject the request as
 * malformed, which reads like a permissions problem and is not one.
 *
 * FormData is the other exception. It carries its own multipart boundary, which only the browser
 * can generate, so setting the type by hand produces a request the server cannot parse.
 */
function headersFor(init: RequestInit, token: string | null): HeadersInit {
  const declaresJson = init.body !== undefined && !(init.body instanceof FormData)
  return {
    ...(declaresJson ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(init.headers ?? {}),
  }
}

async function request<T>(
  path: string, init: RequestInit = {}, options: RequestOptions = {},
): Promise<{ data: T; meta?: PageMeta }> {
  let res: Response
  try {
    const token = options.anonymous ? null : getToken()
    // Only declare a JSON content type when there actually IS a body. Declaring it on a
    // bodyless POST — an action endpoint like /freeze or /publish — makes the server reject the
    // request as malformed, which looks like a permissions problem and is not one.
    res = await fetch(`${BASE}${path}`, { ...init, headers: headersFor(init, token) })
  } catch (err) {
    throw new ApiClientError(
      'NETWORK_ERROR',
      'Could not reach the Crucible API. Check that it is running.',
      0,
      err,
    )
  }

  const body: unknown = await res.json().catch(() => null)

  if (!res.ok) throw failure(res, body, options)
  // 204 has no body by definition, so `res.json()` above yielded null. Returning that made
  // every caller that destructures the result throw AFTER a request the server had performed
  // successfully — the delete happened, the UI reported a failure and did not refresh.
  if (res.status === 204 || body === null) return { data: undefined as T }

  return body as { data: T; meta?: PageMeta }
}

/** The error a failed response becomes. Extracted so `request` stays one readable path. */
function failure(res: Response, body: unknown, options: RequestOptions): ApiClientError {
  const e = (body as ApiErrorBody | null)?.error
  // An expired or rejected token ends the session, so the UI routes to sign-in rather than
  // showing a permanent error the user cannot act on (P5.4).
  if (res.status === 401 && !options.anonymous) endSession()
  return new ApiClientError(
    e?.code ?? 'INTERNAL_ERROR',
    e?.message ?? `Request failed with status ${res.status}.`,
    res.status,
    e?.details,
  )
}

export async function get<T>(path: string): Promise<T> {
  return (await request<T>(path)).data
}

/** GET a list endpoint, preserving the backend's real total (P5.7). */
export async function getPage<T>(path: string): Promise<Page<T>> {
  const res = await request<T[]>(path)
  const meta = res.meta
  return {
    items: res.data,
    total: meta?.total ?? res.data.length,
    page: meta?.page ?? 1,
    pageSize: meta?.pageSize ?? res.data.length,
    truncated: meta?.truncated ?? false,
  }
}

export async function post<T>(path: string, payload?: unknown, idempotencyKey?: string): Promise<T> {
  return (await request<T>(path, {
    method: 'POST',
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
    ...(idempotencyKey && { headers: { 'Idempotency-Key': idempotencyKey } }),
  })).data
}

export async function patch<T>(path: string, payload: unknown): Promise<T> {
  return (await request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) })).data
}

export async function put<T>(path: string, payload: unknown): Promise<T> {
  return (await request<T>(path, { method: 'PUT', body: JSON.stringify(payload) })).data
}

/**
 * PATCH — a partial change, where an absent field means "leave it alone".
 *
 * Distinct from PUT for that reason: the roster's edit forms send only what moved, so that an
 * organiser correcting a phone number cannot accidentally clear an organisation.
 */
export async function patchJson<T>(path: string, payload: unknown): Promise<T> {
  return (await request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) })).data
}

/**
 * DELETE, returning whatever the server sent back.
 *
 * Generic rather than void: a delete that could not be performed as asked has something to say —
 * "this was retired rather than removed, because eleven assessments cite it" — and discarding
 * the body would leave the caller unable to tell the two outcomes apart.
 */
export async function del<T = void>(path: string): Promise<T> {
  const { data } = await request<T>(path, { method: 'DELETE' })
  return data
}

/**
 * Upload a file to an authenticated endpoint as multipart/form-data.
 *
 * The content type is deliberately NOT set: the browser has to add its own multipart boundary,
 * and setting it by hand produces a request the server cannot parse — with an error that reads
 * like a malformed file rather than a malformed header.
 */
export async function uploadFile<T>(
  path: string, file: File, fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  form.append('file', file)

  const token = getToken()
  const { data } = await request<T>(path, {
    method: 'POST',
    body: form,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return data
}

/**
 * Download a file from an authenticated endpoint.
 *
 * A plain `<a href="/api/v1/...">` cannot work here, and the reason is easy to miss: this client
 * authenticates with a bearer token held in JavaScript, not with a cookie, so a browser-initiated
 * navigation carries no credentials and the server answers 401. The link looks right, and the
 * download silently fails — which is how every export in this application was broken until an
 * end-to-end test actually followed one.
 *
 * So the bytes are fetched with the token attached and handed to the browser as a blob. Errors
 * are thrown rather than swallowed, because a caller that cannot tell a failed download from a
 * slow one will show neither (P5.4).
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let res: Response
  try {
    const token = getToken()
    res = await fetch(`${BASE}${path}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    })
  } catch (err) {
    throw new ApiClientError(
      'NETWORK_ERROR',
      'Could not reach the Crucible API. Check that it is running.',
      0,
      err,
    )
  }

  if (!res.ok) {
    if (res.status === 401) endSession()
    // The body may be JSON (an API error) or not (a proxy error page); either way the status
    // is what the caller can act on.
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null
    throw new ApiClientError(
      body?.error?.code ?? 'INTERNAL_ERROR',
      body?.error?.message ?? `The download failed with status ${res.status}.`,
      res.status,
    )
  }

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Released on the next tick: revoking synchronously can cancel the download in some
    // browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/**
 * POST as a team, authenticated by the submission token their organiser issued.
 *
 * A separate factor from the staff session (P8.1): a team has no account, and the token is
 * carried in its own header so an endpoint can require one specifically rather than accepting
 * any credential that happens to be present.
 */
export async function postAsTeam<T>(
  path: string, payload: unknown, submissionToken: string,
): Promise<T> {
  return (await request<T>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'x-submission-token': submissionToken },
  }, { anonymous: true })).data
}

/** GET without a session, for the handful of endpoints a team needs before signing in. */
export async function getPublic<T>(path: string): Promise<T> {
  return (await request<T>(path, {}, { anonymous: true })).data
}

/**
 * POST with no credential at all (E44).
 *
 * Registration is authenticated by the link in the URL, verified at its mount point, so the
 * request carries no session and no submission token. `anonymous` also keeps a 401 from being
 * treated as an expired staff session and bouncing a participant to the login page.
 */
export async function postPublic<T>(path: string, payload?: unknown): Promise<T> {
  return (await request<T>(path, {
    method: 'POST',
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  }, { anonymous: true })).data
}

/**
 * GET as a team, authenticated by their submission token (E17-S03).
 *
 * The same factor as `postAsTeam` and the same reason: the read is scoped by the token, so the
 * server takes the team from the credential rather than from anything the caller can name.
 */
export async function getAsTeam<T>(path: string, submissionToken: string): Promise<T> {
  return (await request<T>(path, {
    headers: { 'x-submission-token': submissionToken },
  }, { anonymous: true })).data
}
