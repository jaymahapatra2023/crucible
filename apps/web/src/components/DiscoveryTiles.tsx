import type { DiscoveryTile } from '../lib/discoveryApi.js'

/**
 * The metric strip at the top of a discovery (E12, P5.1).
 *
 * The rule this component exists to enforce: a tile shows a NUMBER only where a number is a true
 * statement about the submission. Where the extractor could not read enough, or fell over, the
 * tile says so in words.
 *
 * A zero and an unknown look identical on a dashboard and mean opposite things. "0 integrations"
 * says this team built something self-contained; "we could not read the integrations" says
 * nothing about the team at all. A reviewer who cannot tell them apart will read the second as
 * the first and mark a team down for our failure.
 *
 * `warn` is deliberately not a function of size. Two endpoints is not a fault, and colouring a
 * small submission red would turn a description into a judgement the evidence cannot support.
 */
const OUTCOME_TEXT: Record<string, string> = {
  INSUFFICIENT_EVIDENCE: 'Not determined',
  FAILED: 'Could not read',
}

export function DiscoveryTiles({
  tiles, selected, onSelect,
}: {
  tiles: DiscoveryTile[]
  selected: string | null
  onSelect: (key: string) => void
}) {
  return (
    <ul
      aria-label="What discovery found"
      style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 10, listStyle: 'none', padding: 0, margin: '0 0 18px',
      }}
    >
      {tiles.map((tile) => {
        const unknown = tile.count === null
        const active = selected === tile.key
        return (
          <li key={tile.key}>
            <button
              type="button"
              onClick={() => onSelect(tile.key)}
              aria-pressed={active}
              data-warn={tile.warn}
              title={tile.note || undefined}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer',
                border: `1px solid ${tile.warn ? 'var(--warn)' : 'var(--border)'}`,
                borderLeftWidth: tile.warn ? 4 : 1,
                outlineOffset: 2,
                outline: active ? '2px solid var(--accent)' : 'none',
                borderRadius: 8, padding: '10px 12px',
                background: tile.warn ? '#fdf9ef' : 'var(--surface)',
              }}
            >
              <span style={{
                display: 'block', fontSize: 12, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>
                {tile.label}
                {/* The amber border says "look at this" to a sighted reader and to nobody else.
                    P5.5: never colour alone. */}
                {tile.warn && <span className="sr-only"> — needs a look</span>}
              </span>
              <strong style={{
                display: 'block', marginTop: 4,
                fontSize: unknown ? 14 : 24, lineHeight: 1.2,
                color: unknown ? 'var(--warn)' : tile.warn ? 'var(--warn)' : 'var(--text)',
                fontWeight: unknown ? 600 : 700,
              }}>
                {unknown ? (OUTCOME_TEXT[tile.outcome] ?? 'Unknown') : tile.count}
              </strong>
              {unknown && (
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>
                  not a zero
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
