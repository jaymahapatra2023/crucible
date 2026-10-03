import type { ReactNode } from 'react'

/** P5.4 — every empty state says what needs to happen next and offers a way to do it. */
export function EmptyState({
  title,
  explanation,
  action,
}: {
  title: string
  explanation: string
  action?: ReactNode
}) {
  return (
    <div
      style={{
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius)',
        padding: 32,
        textAlign: 'center',
        color: 'var(--text-muted)',
      }}
    >
      <strong style={{ display: 'block', color: 'var(--text)', marginBottom: 6 }}>{title}</strong>
      <p style={{ margin: '0 0 16px' }}>{explanation}</p>
      {action}
    </div>
  )
}
