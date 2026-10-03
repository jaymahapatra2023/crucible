import type { NoticeStatus, SubmissionRow } from '../lib/intakeApi.js'

/**
 * What tier 2 concluded about one entry, and the button that runs it (E46-S02 acceptance 2, 4).
 *
 * Three things are written out rather than coloured (P5.4): the state, the checks needing
 * attention BY NAME, and whether the team was told. "Could not be checked" is kept distinct
 * from "problems" all the way to the screen — an organiser reading UNKNOWN as a failure would
 * chase a team about the harness (P5.1).
 */
export function PreflightCell({
  row, busy, onRun,
}: {
  row: SubmissionRow
  busy: boolean
  onRun?: (submissionId: number, force: boolean) => void
}) {
  const p = row.preflight
  const canRun = onRun !== undefined && row.validationStatus === 'VALID'
  const settled = p === null || p.status === 'COMPLETED' || p.status === 'FAILED'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Outcome row={row} />
      {p !== null && settled && <Told status={p.noticeStatus} />}
      {canRun && settled && (
        <button type="button" disabled={busy} onClick={() => onRun(row.submissionId, p !== null)}
          style={{ alignSelf: 'flex-start', fontSize: 12, padding: '2px 8px' }}>
          {p === null ? 'Run checks' : 'Run again'}
        </button>
      )}
    </div>
  )
}

function Outcome({ row }: { row: SubmissionRow }) {
  const p = row.preflight
  if (p === null) {
    return (
      <span style={{ color: 'var(--text-muted)' }}>
        {row.validationStatus === 'VALID' ? 'Not checked' : 'Waits for tier 1'}
      </span>
    )
  }
  if (p.status === 'QUEUED') return <span>Queued</span>
  if (p.status === 'RUNNING') return <span>Checking…</span>
  if (p.status === 'FAILED') {
    return (
      <span>
        <strong>Checks did not finish</strong>
        {p.error && <span style={{ color: 'var(--text-muted)' }}> — {p.error}</span>}
      </span>
    )
  }

  const failing = p.attention.filter((c) => c.status === 'FAIL').map((c) => c.label)
  const unknown = p.attention.filter((c) => c.status === 'UNKNOWN').map((c) => c.label)
  return (
    <span>
      <strong>{p.verdict === 'UNKNOWN' ? 'Could not be checked' : p.verdict}</strong>
      {failing.length > 0 && (
        <span style={{ color: 'var(--danger)' }}>: {failing.join(', ')}</span>
      )}
      {unknown.length > 0 && (
        <span style={{ color: 'var(--text-muted)' }}>
          {failing.length > 0 ? ' · ' : ': '}not checked: {unknown.join(', ')}
        </span>
      )}
    </span>
  )
}

/** Whether the team heard — a run nobody was told about is the gap E34's panel exists for. */
function Told({ status }: { status: NoticeStatus | null }) {
  const text = status === 'SENT' ? 'team told'
    : status === 'PREPARED' ? 'message prepared, not sent'
    : status === 'UNCHANGED' ? 'unchanged, not re-sent'
    : status === 'FAILED' ? 'team NOT told'
    : 'nobody told yet'
  return (
    <span style={{ fontSize: 12, color: status === 'FAILED' ? 'var(--danger)' : 'var(--text-muted)' }}>
      {text}
    </span>
  )
}
