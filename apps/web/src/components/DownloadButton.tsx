/**
 * A link that downloads from an authenticated endpoint.
 *
 * Looks like a link and behaves like one, but fetches with the session token rather than letting
 * the browser navigate — see `downloadFile`. It exists as a component so there is one download
 * path in the application: the previous arrangement had five plain anchors, each of which
 * silently produced a 401 instead of a file.
 *
 * A failure is shown, not swallowed. A download that does nothing is indistinguishable from a
 * slow one, and a reviewer will click it twice and then give up (P5.4).
 */
import { useState } from 'react'
import { downloadFile } from '../lib/apiClient.js'

export function DownloadButton({
  path, filename, label, testId,
}: {
  path: string
  filename: string
  label: string
  testId?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      await downloadFile(path, filename)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        {...(testId !== undefined && { 'data-testid': testId })}
        style={{
          border: 'none', background: 'none', padding: 0,
          font: 'inherit', color: 'var(--link, #0b62d0)',
          textDecoration: 'underline', cursor: busy ? 'progress' : 'pointer',
        }}
      >
        {busy ? 'Preparing…' : label}
      </button>
      {error && (
        <span role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginLeft: 8 }}>
          {error}
        </span>
      )}
    </>
  )
}
