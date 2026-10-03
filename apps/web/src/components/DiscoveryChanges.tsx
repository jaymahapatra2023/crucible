import { useState } from 'react'
import { getChanges, type DiscoveryChanges as Changes } from '../lib/discoveryApi.js'

/**
 * What moved since the discovery this one replaced (E16-S04).
 *
 * Fetched on demand rather than with the page: most discoveries are never compared, and a
 * comparison nobody asked for is a query nobody needed.
 *
 * The caveat is not decoration. A finding that is no longer reported may have been fixed, or
 * may simply not have been read this time — the two are indistinguishable from here, and
 * presenting "gone" as "resolved" would invent a conclusion the evidence does not support.
 */
export function DiscoveryChanges({ submissionId }: { submissionId: string }) {
  const [changes, setChanges] = useState<Changes | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function load() {
    setBusy(true)
    setFailure(null)
    try {
      setChanges(await getChanges(submissionId))
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The comparison could not be loaded.')
    } finally {
      setBusy(false)
    }
  }

  if (changes === null) {
    return (
      <p style={{ marginTop: 20 }}>
        <button type="button" onClick={() => void load()} disabled={busy}>
          {busy ? 'Comparing…' : 'Compare with the previous discovery'}
        </button>
        {failure && <span role="alert" style={{ color: 'var(--danger)' }}> {failure}</span>}
      </p>
    )
  }

  if (!changes.comparable) {
    return (
      <p style={{ marginTop: 20, color: 'var(--text-muted)' }} data-testid="changes-none">
        {changes.note}
      </p>
    )
  }

  return (
    <section
      data-testid="changes"
      style={{
        border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 20,
        background: 'var(--surface)',
      }}
    >
      <h3 style={{ fontSize: 15, marginTop: 0 }}>Since the previous discovery</h3>
      <p style={{ color: 'var(--text-muted)' }}>{changes.note}</p>

      {changes.resolvedSecurity.length > 0 && (
        <p style={{
          border: '1px solid var(--ok)', borderRadius: 6, padding: '8px 10px',
          background: 'var(--bg)',
        }}>
          <strong style={{ color: 'var(--ok)' }}>
            {changes.resolvedSecurity.length} security observation
            {changes.resolvedSecurity.length === 1 ? '' : 's'} no longer reported
          </strong>
          {' — '}
          {changes.resolvedSecurity.map((f) => f.label).join(', ')}. Worth confirming against the
          code rather than assuming it was fixed.
        </p>
      )}

      <ChangeList title="Appeared" entries={changes.added} />
      <ChangeList title="No longer reported" entries={changes.disappeared} />
      <p style={{ color: 'var(--text-muted)', margin: 0 }}>
        {changes.unchanged} finding{changes.unchanged === 1 ? '' : 's'} unchanged.
      </p>
    </section>
  )
}

function ChangeList({
  title, entries,
}: {
  title: string
  entries: Array<{ kind: string; label: string; path: string }>
}) {
  if (entries.length === 0) return null
  return (
    <>
      <h4 style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-muted)', margin: '12px 0 6px' }}>
        {title}
      </h4>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {entries.map((e) => (
          <li key={`${e.kind}:${e.label}:${e.path}`}>
            <strong>{e.label}</strong>
            <code style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              {e.path}
            </code>
          </li>
        ))}
      </ul>
    </>
  )
}
