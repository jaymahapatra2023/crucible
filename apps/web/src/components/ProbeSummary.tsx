/**
 * The build probe result and provenance observations (E08-S02 acceptance 3 and 4).
 *
 * The log link is restricted and audited on the server; it is offered here because "does it
 * build" is often the fastest way to tell a broken submission from a broken harness — and the
 * difference between those two decides whether a team is penalised for something that is our
 * fault.
 */
import { DownloadButton } from './DownloadButton.js'
import type { TeamDetail } from '../lib/reviewApi.js'

const GRADE_TEXT: Record<string, string> = {
  RUNS: 'Built and stayed up.',
  BUILDS_ONLY: 'Built successfully; whether it stays up was not observed.',
  BLOCKED_BY_SANDBOX: 'Started, then stopped because the sandbox denied the network or a write '
    + 'outside its own directory. Scored 3 of 4 rather than 0 — the environment caused it.',
  BUILD_FAILED: 'The build failed.',
  UNSUPPORTED_STACK: 'Crucible has no recipe for this stack, so it was never built.',
  PROBE_ERROR: 'The harness failed while probing, so this is unknown.',
}

export function ProbeSummary({
  probe, provenance,
}: {
  probe: TeamDetail['probe']
  provenance: TeamDetail['provenance']
}) {
  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Build and history</h2>

      {probe === null ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          This submission was never built, so whether it runs is unknown. The Runs dimension was
          left out of its composite rather than scored zero.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 13, margin: '0 0 4px' }}>
            <strong data-testid="probe-grade">{probe.runs_grade}</strong>
            {' — '}
            {GRADE_TEXT[probe.runs_grade] ?? probe.grade_reason}
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
            {probe.grade_reason}
          </p>
          <span style={{ fontSize: 12 }}>
            <DownloadButton
              path={`/probes/${probe.probe_id}/log`}
              filename={`build-log-probe-${probe.probe_id}.txt`}
              label="Download the build log"
              testId="probe-log"
            />
          </span>
          {probe.log_truncated && (
            <span style={{ fontSize: 11, color: 'var(--warn)' }}> (truncated)</span>
          )}
        </>
      )}

      <h3 style={{ fontSize: 13, margin: '12px 0 4px' }}>Provenance</h3>
      {provenance.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          Nothing in the commit history needed a second look.
        </p>
      ) : (
        <ul style={{ fontSize: 12, paddingLeft: 18, margin: 0 }}>
          {/* Worded by the scanner with the innocent explanation attached; shown as written. */}
          {provenance.map((p) => <li key={p.code}>{p.message}</li>)}
        </ul>
      )}
    </section>
  )
}
