import type { Conflict } from '../lib/discoveryApi.js'

/**
 * Where the documentation and the code appear to disagree (E12).
 *
 * The most delicate thing this application displays, and the presentation carries the caution
 * rather than leaving it to the reader. Three things are non-negotiable here:
 *
 *  - The heading says "worth checking", not "discrepancy found".
 *  - Every conflict shows the innocent explanation next to the observation. The server attaches
 *    it to the observed text itself, so there is no render path that drops it.
 *  - The framing paragraph is always shown, never collapsed behind a toggle.
 *
 * Teams write documentation before they write code, during a weekend, under time pressure. A gap
 * between the two is ordinary, and presenting it as dishonesty would be a serious harm done by
 * a system that cannot see the whole repository.
 */
export function DiscoveryConflicts({ conflicts }: { conflicts: Conflict[] }) {
  if (conflicts.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        Nothing in the documentation contradicted what was found in the code.
      </p>
    )
  }

  return (
    <section>
      <p style={{
        border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
        background: 'var(--bg)', marginTop: 0,
      }}>
        These are claims in the repository's own documentation that the code read so far does not
        appear to support. They are <strong>prompts to look</strong>, not findings of fact and
        certainly not findings of dishonesty — only part of the repository was read, and
        documentation written ahead of the code is normal. Check each one before it influences a
        score.
      </p>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {conflicts.map((c) => (
          <li key={c.conflict_id} style={{
            border: '1px solid var(--border)', borderLeft: '4px solid var(--warn)',
            borderRadius: 8, padding: 12, marginBottom: 10, background: 'var(--surface)',
          }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <strong style={{ fontSize: 14 }}>Worth checking</strong>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {c.confidence.toLowerCase()} confidence
              </span>
              <code style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                {c.claim_path}{c.claim_line !== null && `:${c.claim_line}`}
              </code>
            </div>

            <blockquote style={{
              margin: '8px 0', padding: '6px 12px',
              borderLeft: '3px solid var(--border)', color: 'var(--text)',
            }}>
              {c.claim}
            </blockquote>

            <p style={{ margin: '6px 0' }}>
              <span style={{ color: 'var(--text-muted)' }}>If that held, the code would show: </span>
              {c.expected}
            </p>
            <p style={{ margin: '6px 0 0' }}>
              <span style={{ color: 'var(--text-muted)' }}>What was found: </span>
              {c.observed}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
