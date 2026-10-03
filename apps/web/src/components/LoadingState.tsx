/** Busy state. Announced politely so screen readers report it without stealing focus (P5.5). */
export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" style={{ padding: 24, color: 'var(--text-muted)' }}>
      {label}…
    </div>
  )
}
