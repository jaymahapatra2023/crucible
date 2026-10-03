/**
 * The system-level definition of done (plan §IV.5).
 *
 * Seven statements, each shown with what was actually found rather than a tick. "Two of fifty
 * submissions were never probed" tells an operator what to do next; a red cross does not.
 *
 * UNKNOWN is rendered distinctly from FAIL on purpose. "We could not check this" and "this is
 * not done" lead to different actions, and collapsing them is how an unchecked item becomes an
 * assumed one.
 */
import type { ReadinessReport } from '../lib/readinessApi.js'

const TONE: Record<string, string> = {
  PASS: 'var(--ok)',
  FAIL: 'var(--danger)',
  UNKNOWN: 'var(--warn)',
}

const LABEL: Record<string, string> = {
  PASS: 'done',
  FAIL: 'not done',
  UNKNOWN: 'could not check',
}

export function ReadinessChecklist({ report }: { report: ReadinessReport }) {
  const outstanding = report.checks.filter((c) => c.status !== 'PASS').length

  return (
    <section>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>
        Readiness — {report.ready
          ? 'every statement holds'
          : `${outstanding} of ${report.checks.length} outstanding`}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        The conditions the plan says must hold before this system decides anything, checked
        against the database rather than against anyone’s memory of having done them.
      </p>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {report.checks.map((check) => (
          <li
            key={check.id}
            data-testid={`check-${check.id}`}
            data-status={check.status}
            style={{
              borderLeft: `3px solid ${TONE[check.status] ?? 'var(--border)'}`,
              padding: '6px 10px', marginBottom: 6,
            }}
          >
            <strong style={{ fontSize: 13 }}>{check.statement}</strong>
            <span style={{ color: TONE[check.status], fontSize: 12 }}>
              {' — '}{LABEL[check.status] ?? check.status}
            </span>
            {/* What was found, which is the part an operator acts on. */}
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>
              {check.detail}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
