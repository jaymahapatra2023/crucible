import { FindingDetail } from './FindingDetail.js'
import { DismissObservation } from './DismissObservation.js'
import type { DiscoveryTile, Finding } from '../lib/discoveryApi.js'

/**
 * One concern's findings, as a collapsible section (E12).
 *
 * Every finding carries its file and line range, shown next to the excerpt it was drawn from.
 * That is what makes a finding disputable: a reviewer who disagrees can open the file at the
 * line and settle it, rather than taking the description on trust.
 *
 * A section whose concern could not be read renders as a stated gap, never as an empty list.
 */
const CONFIDENCE_TONE: Record<string, string> = {
  HIGH: 'var(--ok)', MEDIUM: 'var(--text-muted)', LOW: 'var(--warn)',
}

export function DiscoverySection({
  title, tile, findings, open, busy, onDismiss, onReinstate,
}: {
  title: string
  tile: DiscoveryTile | undefined
  findings: Finding[]
  open: boolean
  busy?: boolean
  onDismiss?: (findingId: number, reason: string) => void
  onReinstate?: (findingId: number) => void
}) {
  const unreadable = tile !== undefined && tile.count === null

  return (
    <details open={open} style={{
      border: '1px solid var(--border)', borderRadius: 8,
      marginBottom: 12, background: 'var(--surface)',
    }}>
      <summary style={{ cursor: 'pointer', padding: '10px 14px', fontWeight: 600 }}>
        {title}
        <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontWeight: 400 }}>
          {unreadable ? 'not determined' : `${findings.length}`}
        </span>
      </summary>

      <div style={{ padding: '0 14px 14px' }}>
        {unreadable ? (
          <p style={{
            border: '1px solid var(--warn)', background: '#fdf9ef',
            borderRadius: 6, padding: '10px 12px', margin: 0, color: 'var(--text)',
          }}>
            <strong style={{ color: 'var(--warn)' }}>
              This could not be determined from what was read.
            </strong>
            <br />
            {tile.note}
            <br />
            <span style={{ color: 'var(--text-muted)' }}>
              That is a gap in our reading, not a statement that the submission has none of
              these. Nothing is scored down for it.
            </span>
          </p>
        ) : findings.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>
            The extractor read the code and found none of these.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {findings.map((f, i) => (
              <li key={`${f.path}:${f.line_start}:${i}`} style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--border)', padding: '10px 0',
                // A set-aside observation is dimmed, not hidden: a reader must still be able to
                // tell "we looked and it was fine" from "we never mentioned it".
                opacity: f.dismissed ? 0.62 : 1,
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14 }}>{f.label}</strong>
                  <span style={{
                    fontSize: 12, color: CONFIDENCE_TONE[f.confidence] ?? 'var(--text-muted)',
                  }}>
                    {f.confidence.toLowerCase()} confidence
                  </span>
                  <code style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                    {f.path}{f.line_start !== null && `:${f.line_start}`}
                    {f.line_end !== null && f.line_end !== f.line_start && `–${f.line_end}`}
                  </code>
                </div>

                {f.summary && <p style={{ margin: '6px 0' }}>{f.summary}</p>}

                <FindingDetail finding={f} />

                {/* Only security observations carry a benign explanation to check, so only
                    they offer a way to record that it was checked. */}
                {f.kind === 'SECURITY' && onDismiss && onReinstate && (
                  <DismissObservation
                    finding={f} busy={busy === true}
                    onDismiss={onDismiss} onReinstate={onReinstate} />
                )}

                {f.excerpt && (
                  <pre style={{
                    margin: '8px 0 0', padding: '8px 10px', overflowX: 'auto',
                    background: 'var(--bg)', border: '1px solid var(--border)',
                    borderRadius: 6, fontSize: 12,
                  }}>
                    <code>{f.excerpt}</code>
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
