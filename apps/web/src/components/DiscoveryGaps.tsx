import type { Discovery } from '../lib/discoveryApi.js'

/**
 * What discovery could not read (E12, P5.1).
 *
 * Shown at the top of the page rather than at the bottom, because a reviewer needs to know the
 * description is incomplete before they read it — not after they have formed a view from it.
 *
 * The closing sentence is the point: these are gaps in our reading, and nothing is scored down
 * for them. Without it a list of missing concerns reads as a list of the team's omissions.
 */
export function DiscoveryGaps({ gaps, total }: { gaps: Discovery['gaps']; total: number }) {
  if (gaps.length === 0) return null

  return (
    <div role="note" style={{
      border: '1px solid var(--warn)', borderRadius: 8, padding: '10px 14px',
      background: '#fdf9ef', marginBottom: 18,
    }}>
      <strong style={{ color: 'var(--warn)' }}>
        {gaps.length === total
          ? 'Nothing could be read from this repository'
          : `${gaps.length} of ${total} concerns could not be determined`}
      </strong>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {gaps.map((g) => <li key={g.key}><strong>{g.label}</strong> — {g.note}</li>)}
      </ul>
      <p style={{ margin: '8px 0 0', color: 'var(--text-muted)' }}>
        These are gaps in what we managed to read, not statements about the submission. Nothing
        is scored down for them.
      </p>
    </div>
  )
}

/** How the submission starts, where the stack extractor could see it. */
export function DiscoveryRuntime({ runtime }: { runtime: Discovery['runtime'] }) {
  if (!runtime) return null
  return (
    <p style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px',
      background: 'var(--surface)',
    }}>
      <strong>How it runs: </strong>
      {runtime.containerised ? 'containerised' : 'not containerised'}
      {runtime.entrypoint && <> · entrypoint <code>{runtime.entrypoint}</code></>}
      {runtime.notes && <> · {runtime.notes}</>}
    </p>
  )
}
