import { useState } from 'react'
import { get } from '../lib/apiClient.js'

interface BriefPassage {
  sourceRef: string
  matched: boolean
  reason?: string
  section?: { filename: string; label: string; text: string }
}

/**
 * A criterion's reference to the brief, expandable to the actual passage (E02-S06 acceptance 3).
 *
 * Fetched on demand rather than eagerly: a rubric has many criteria and a reviewer checks the
 * provenance of a few. When the reference cannot be resolved this says so plainly — an
 * unverifiable citation the reviewer believes is verified is worse than an obvious gap.
 */
export function SourceRefLink({
  challengeId,
  sourceRef,
}: {
  challengeId: string
  sourceRef: string
}) {
  const [passage, setPassage] = useState<BriefPassage | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (passage || loading) return
    setLoading(true)
    setError(null)
    try {
      setPassage(await get<BriefPassage>(
        `/challenges/${challengeId}/brief/passage?sourceRef=${encodeURIComponent(sourceRef)}`,
      ))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The brief could not be read.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <span>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        style={{
          background: 'none', border: 'none', padding: 0, font: 'inherit',
          color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer',
        }}
      >
        {sourceRef}
      </button>

      {open && (
        <div
          style={{
            marginTop: 6, padding: '8px 10px', borderLeft: '3px solid var(--border)',
            background: 'var(--bg)', borderRadius: 4,
          }}
        >
          {loading && <span style={{ color: 'var(--text-muted)' }}>Looking up the brief…</span>}
          {error && <span role="alert" style={{ color: 'var(--danger)' }}>{error}</span>}

          {passage?.matched && passage.section && (
            <>
              <strong style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                {passage.section.filename} — {passage.section.label}
              </strong>
              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                {passage.section.text.slice(0, 1200)}
                {passage.section.text.length > 1200 ? '…' : ''}
              </p>
            </>
          )}

          {passage && !passage.matched && (
            <span role="status" style={{ color: 'var(--warn)' }}>{passage.reason}</span>
          )}
        </div>
      )}
    </span>
  )
}
