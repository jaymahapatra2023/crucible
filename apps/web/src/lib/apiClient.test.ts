/**
 * API client tests (P6.2, P5.7).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, del, get, getPage, post } from './apiClient.js'

const mockFetch = (body: unknown, status = 200) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))
}

afterEach(() => vi.unstubAllGlobals())

describe('envelope unwrapping', () => {
  it('returns data on success', async () => {
    mockFetch({ data: { status: 'ok' } })
    expect(await get<{ status: string }>('/platform/health')).toEqual({ status: 'ok' })
  })

  it('throws ApiClientError carrying the code on failure', async () => {
    mockFetch({ error: { code: 'FORBIDDEN', message: 'Not allowed.' } }, 403)
    await expect(get('/x')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('surfaces the server message rather than a status code (P5.4)', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Run 9 was not found.' } }, 404)
    await expect(get('/x')).rejects.toThrow('Run 9 was not found.')
  })

  it('reports an unreachable API distinctly from a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    await expect(get('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('handles a non-JSON error body without throwing a parse error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway timeout', { status: 504 })))
    await expect(get('/x')).rejects.toBeInstanceOf(ApiClientError)
  })
})

describe('getPage — data honesty (P5.7)', () => {
  it('takes total from meta, never from the array length', async () => {
    mockFetch({ data: [1, 2, 3], meta: { total: 42, page: 1, pageSize: 3, truncated: true } })
    const page = await getPage<number>('/runs')
    expect(page.total).toBe(42)
    expect(page.items).toHaveLength(3)
    expect(page.truncated).toBe(true)
  })

  it('falls back to the array length only when the server sent no meta', async () => {
    mockFetch({ data: [1, 2] })
    const page = await getPage<number>('/runs')
    expect(page.total).toBe(2)
    expect(page.truncated).toBe(false)
  })
})

describe('post', () => {
  it('sends NO content-type when there is no body, so action endpoints are not rejected', async () => {
    const spy = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', spy)
    await post('/rubrics/1/freeze')
    const init = spy.mock.calls[0]![1]
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })

  it('sends the payload and an idempotency key when given (P6.4)', async () => {
    const spy = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 201, headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', spy)
    await post('/runs', { kind: 'SCAN' }, 'key-123')
    const init = spy.mock.calls[0]![1]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'SCAN' })
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-123')
  })
})

describe('a response with no content', () => {
  it('resolves rather than throwing on 204', async () => {
    // Every delete in the application goes through here. Returning the null body made callers
    // that destructure the result throw AFTER the server had done the work: the row was gone,
    // the UI said it had failed, and nothing refreshed.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(del('/roster/members/1')).resolves.toBeUndefined()
  })

  it('still throws on an error status with no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await expect(del('/roster/members/1')).rejects.toThrow(/status 403/)
  })
})
