/**
 * Authenticated downloads (E09-S02, E07-S03, E08-S05).
 *
 * This component exists because of a real defect: every export in the application was a plain
 * `<a href="/api/v1/...">`, and this client authenticates with a bearer token in JavaScript
 * rather than a cookie. The browser sent no credentials, the server answered 401, and the
 * download silently did nothing. These tests pin both halves of the fix — the token is attached,
 * and a failure is visible.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DownloadButton } from './DownloadButton.js'
import { startSession, endSession } from '../lib/session.js'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  // Only these two are stubbed: replacing the whole URL global breaks jsdom's own machinery.
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()

  startSession('test-token', {
    userId: 'u1', email: 'a@test.local', displayName: 'A', role: 'organiser',
  })
  fetchMock.mockReset().mockResolvedValue({
    ok: true, status: 200, blob: async () => new Blob(['hello']),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  endSession()
})

describe('the download', () => {
  it('ATTACHES the session token, which a plain link cannot', async () => {
    render(<DownloadButton path="/x/y.csv" filename="y.csv" label="Export" />)
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/x/y.csv')
    expect((init.headers as Record<string, string>)['authorization'])
      .toBe('Bearer test-token')
  })

  it('SHOWS a failure rather than doing nothing', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ error: { code: 'FORBIDDEN', message: 'Not your record.' } }),
    })

    render(<DownloadButton path="/x/y.csv" filename="y.csv" label="Export" />)
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Not your record.')
  })

  it('reports a network failure in words a user can act on', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))

    render(<DownloadButton path="/x/y.csv" filename="y.csv" label="Export" />)
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the Crucible API/)
  })

  it('says it is working, so a slow download is not mistaken for a broken one', async () => {
    let release: (v: unknown) => void = () => undefined
    fetchMock.mockReturnValue(new Promise((resolve) => { release = resolve }))

    render(<DownloadButton path="/x/y.csv" filename="y.csv" label="Export" />)
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))

    expect(await screen.findByRole('button', { name: 'Preparing…' })).toBeDisabled()
    release({ ok: true, status: 200, blob: async () => new Blob(['x']) })
  })

  it('clears a previous error when retried', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: { code: 'X', message: 'Boom.' } }),
    })

    render(<DownloadButton path="/x/y.csv" filename="y.csv" label="Export" />)
    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
