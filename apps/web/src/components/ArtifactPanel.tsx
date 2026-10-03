import type { SubmissionArtifact } from '../lib/artifactApi.js'

/**
 * The supporting documents a team attached (E36).
 *
 * These links existed on every submission since E03 and were shown nowhere. A reviewer could not
 * see that a team had attached an architecture document, which made two of the judging criteria
 * unanswerable from this page — the one page that is supposed to hold everything a placement
 * rests on.
 *
 * **The text is untrusted.** A team chose both the address and every word at it, knowing a model
 * would read it. It is presented as quoted evidence, never as narration, and a link is never made
 * clickable-by-default to somewhere a reviewer did not choose to go.
 */
export function ArtifactPanel({
  artifacts, busy, onFetch,
}: {
  artifacts: readonly SubmissionArtifact[]
  busy: boolean
  /** Null for a reader who may not trigger a fetch. */
  onFetch: (() => void) | null
}) {
  const read = artifacts.filter((a) => a.status === 'FETCHED')
  const unread = artifacts.filter((a) => a.status !== 'FETCHED')

  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 15 }}>Attached documents</h2>

      {artifacts.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {/* Absence of a record is not absence of links — say which this is (P5.1). */}
          Nothing has been read for this submission. Either the team attached no supporting links,
          or nobody has fetched them yet.
          {onFetch && ' Use the button below to try.'}
        </p>
      ) : (
        <>
          {read.map((a) => (
            <article key={a.artifactId} style={{
              border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 8,
            }}>
              <header style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                <a href={a.url} target="_blank" rel="noreferrer noopener">{a.url}</a>
                {a.contentType !== null && ` · ${a.contentType.split(';')[0]}`}
                {a.detail !== '' && ` · ${a.detail}`}
              </header>
              {/* Quoted, monospaced and scrollable: it reads as a document somebody else wrote,
                  which is what it is. */}
              <pre style={{
                margin: '6px 0 0', maxHeight: 240, overflow: 'auto', fontSize: 12,
                whiteSpace: 'pre-wrap', background: 'var(--sunk, transparent)', padding: 8,
              }}>
                {a.textContent}
              </pre>
            </article>
          ))}

          {unread.length > 0 && (
            <ul style={{ paddingLeft: 18, fontSize: 13, margin: '8px 0 0' }}>
              {unread.map((a) => (
                <li key={a.artifactId}>
                  {/* The state is written out, never colour alone (P5.4). */}
                  <strong>{a.status.replace(/_/g, ' ').toLowerCase()}</strong> — {a.url}
                  {a.detail !== '' && <> · {a.detail}</>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {onFetch && (
        <button type="button" disabled={busy} onClick={onFetch} style={{ marginTop: 8 }}>
          {artifacts.length === 0 ? 'Fetch attached documents' : 'Fetch again'}
        </button>
      )}
    </section>
  )
}
