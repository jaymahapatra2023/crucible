import type { ReactNode } from 'react'

/**
 * One catalogue entry as a row (E12).
 *
 * The adoption switch is the important control and is shown as such. Authoring is not adoption:
 * a newly written principle sits in the catalogue unassessed until someone deliberately adopts
 * it, so that writing one down cannot silently change what every team is being scored against.
 */
export function CatalogueRow({
  code, name, group, description, adopted, mandatory, busy,
  onToggleAdopted, onEdit, onRetire, badges,
}: {
  code: string
  name: string
  group: string
  description: string
  adopted: boolean
  mandatory?: boolean
  busy: boolean
  onToggleAdopted: () => void
  onEdit: () => void
  onRetire: () => void
  badges?: ReactNode
}) {
  return (
    <article
      style={{
        border: '1px solid var(--border)',
        borderLeft: `4px solid ${adopted ? 'var(--ok)' : 'var(--border)'}`,
        borderRadius: 8, padding: 12, marginBottom: 10, background: 'var(--surface)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <code style={{ fontSize: 12, color: 'var(--text-muted)' }}>{code}</code>
        <h3 style={{ margin: 0, fontSize: 15 }}>{name}</h3>
        <span style={{
          fontSize: 12, color: 'var(--text-muted)', border: '1px solid var(--border)',
          borderRadius: 999, padding: '1px 8px',
        }}>
          {group || 'uncategorised'}
        </span>
        {mandatory === false && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>advisory</span>
        )}
        {badges}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox" checked={adopted} disabled={busy}
              onChange={onToggleAdopted}
              aria-label={`Assess submissions against ${name}`}
            />
            Adopted
          </label>
          <button type="button" onClick={onEdit} disabled={busy}>Edit</button>
          <button type="button" onClick={onRetire} disabled={busy}>Retire</button>
        </span>
      </header>
      <p style={{ margin: '8px 0 0' }}>{description}</p>
    </article>
  )
}
