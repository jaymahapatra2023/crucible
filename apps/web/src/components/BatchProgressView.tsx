/**
 * Live progress for a cohort run (E10-S05).
 *
 * Read from the server rather than accumulated from websocket messages, because acceptance 2 is
 * "survives page reload" and a reload has no history. Polling is the honest implementation: it
 * shows what the run has written down, which is the same thing an operator would see if they
 * opened the page for the first time an hour in.
 *
 * Where a figure is not yet known it says so. An operator plans around an estimated finish —
 * they go to bed on it — so "not yet known" is worth more than a number derived from one
 * submission.
 */
import type { BatchProgress } from '../lib/batchApi.js'

const STAGE_LABEL: Record<string, string> = {
  scan: 'Scanning repositories',
  probe: 'Building and running',
  discovery: 'Describing what each team built',
  score: 'Scoring against the rubric',
}

export function BatchProgressView({ progress }: { progress: BatchProgress }) {
  const done = progress.stages.reduce((sum, s) => sum + s.done, 0)
  const expected = progress.total * progress.stages.length

  return (
    <section>
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>
          Run {progress.runId} — <StatusText status={progress.status} />
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          <span data-testid="overall-progress">
            {done} of {expected} steps
          </span>
          {' · '}
          <span data-testid="cost">${progress.costUsd.toFixed(2)} spent</span>
          {progress.projectedCostUsd !== null && (
            <span data-testid="projected">
              {' · '}about ${progress.projectedCostUsd.toFixed(2)} projected
            </span>
          )}
          {' · '}
          <span data-testid="eta">
            {progress.estimatedFinishAt === null
              // Said, not hidden: an operator who sees no estimate should know it is unmeasured
              // rather than assume the page is broken.
              ? 'finish time not yet known'
              : `expected to finish ${new Date(progress.estimatedFinishAt).toLocaleTimeString()}`}
          </span>
        </p>
      </header>

      {progress.pausedReason && (
        <p role="status" data-testid="paused-reason" style={warnBox}>
          {progress.pausedReason}
        </p>
      )}

      {progress.currentLabel && progress.status === 'RUNNING' && (
        <p style={{ fontSize: 13, margin: '0 0 8px' }} data-testid="current-item">
          Now: {STAGE_LABEL[progress.currentStage ?? ''] ?? progress.currentStage}
          {' — '}{progress.currentLabel}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Done</th>
            <th scope="col">Succeeded</th>
            <th scope="col">Failed</th>
            <th scope="col">Skipped</th>
          </tr>
        </thead>
        <tbody>
          {progress.stages.map((stage) => (
            <tr key={stage.stage} data-testid={`stage-${stage.stage}`}>
              <td>{STAGE_LABEL[stage.stage] ?? stage.stage}</td>
              <td>{stage.done} of {progress.total}</td>
              <td>{stage.ok}</td>
              <td>
                {stage.failed > 0
                  ? <strong style={{ color: 'var(--warn)' }}>{stage.failed}</strong>
                  : 0}
              </td>
              <td>{stage.skipped}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {progress.failures.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, marginTop: 16 }}>
            {progress.failures.length} failure{progress.failures.length === 1 ? '' : 's'}
          </h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
            Each of these was recorded and the run continued. A submission that failed a stage
            was not scored down for it — it was left unmeasured.
          </p>
          <ul style={{ fontSize: 12, paddingLeft: 18 }}>
            {progress.failures.map((f) => (
              <li key={`${f.stage}:${f.subjectId}`}>
                <strong>{f.stage}</strong> · submission {f.subjectId}: {f.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function StatusText({ status }: { status: string }) {
  const tone = status === 'PAUSED' ? 'var(--warn)'
    : status === 'FAILED' ? 'var(--danger)'
    : status === 'SUCCEEDED' ? 'var(--ok)'
    : 'var(--text-muted)'
  return <span style={{ color: tone }} data-testid="run-status">{status}</span>
}

const warnBox = {
  fontSize: 13, color: 'var(--warn)', border: '1px solid var(--warn)',
  borderRadius: 6, padding: 10, margin: '0 0 10px',
} as const
