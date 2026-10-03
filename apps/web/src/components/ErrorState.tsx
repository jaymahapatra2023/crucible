/**
 * Failure state (P5.4, P5.7).
 *
 * Deliberately distinct from an empty state: a failed fetch rendered as "0 results" invites a
 * reviewer to conclude there is nothing there. It answers what happened, who is affected, and
 * what to do now, and offers a retry rather than a dead end.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  detail,
}: {
  title: string
  message: string
  onRetry?: () => void
  detail?: string
}) {
  return (
    <div
      role="alert"
      style={{
        border: '1px solid var(--danger)',
        borderRadius: 'var(--radius)',
        padding: 16,
        background: '#fdf6f5',
      }}
    >
      <strong style={{ display: 'block', color: 'var(--danger)', marginBottom: 4 }}>{title}</strong>
      <p style={{ margin: '0 0 12px' }}>{message}</p>
      {detail && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>View details</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 }}>{detail}</pre>
        </details>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry} style={buttonStyle}>
          Retry
        </button>
      )}
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  font: 'inherit',
}
