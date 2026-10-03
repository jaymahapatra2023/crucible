/**
 * Whether this system is permitted to rank (E11-S03).
 *
 * Shown wherever a ranking is, because the most dangerous state is the quiet one: a system that
 * has never been calibrated looks exactly like a calibrated one until somebody presses the
 * button. The banner is deliberately loud when no decision exists, and says what is still
 * available rather than only what is not.
 */
import type { GateResponse } from '../lib/calibrationApi.js'

export function GateBanner({ gate }: { gate: GateResponse }) {
  if (gate.rankingPermitted) return <Passed gate={gate} />

  if (gate.status?.decision === 'NO_GO') {
    return (
      <p role="status" data-testid="gate-no-go" style={box}>
        <strong>Ranking is disabled.</strong> The calibration gate was failed by{' '}
        {gate.status.decided_by} on {new Date(gate.status.decided_at).toLocaleDateString()}:{' '}
        {gate.status.rationale}
        {' '}
        The recorded fallback is: {gate.status.fallback_plan}{' '}
        Scanning, probing, scoring and the per-team records remain available — this system can
        still gather evidence for people to judge from.
      </p>
    )
  }

  return (
    <p role="status" data-testid="gate-undecided" style={box}>
      <strong>This system has not been calibrated.</strong>{' '}
      {gate.note ?? 'No go/no-go decision has been recorded, so ranking is refused.'}
      {' '}
      Evidence gathering remains available.
    </p>
  )
}

const box = {
  fontSize: 13, color: 'var(--warn)', border: '1px solid var(--warn)',
  borderRadius: 6, padding: 10, margin: '0 0 12px',
} as const

/**
 * A gate that was passed — and whether it still applies.
 *
 * Split out because the "passed but the settings moved" case has its own branch, and folding it
 * into the banner made one function hold four unrelated states.
 *
 * The stale case is the quiet failure worth being loud about: the verdict still reads GO, and it
 * was measured on settings that no longer apply, so reading it as blanket permission is wrong.
 */
function Passed({ gate }: { gate: GateResponse }) {
  // Only a KNOWN difference is loud. `null` means the decision predates configuration
  // recording, which is a quieter fact and would otherwise cry wolf on every historical gate.
  const stale = gate.status?.coversCurrentConfig === false
  const unknownConfig = gate.status?.coversCurrentConfig === null
  const decided = gate.status ? new Date(gate.status.decided_at).toLocaleDateString() : ''
  const correlation = gate.status?.rank_correlation

  return (
    <p
      data-testid={stale ? 'gate-stale' : 'gate-ok'}
      style={{
        ...box,
        borderColor: stale ? 'var(--warn)' : 'var(--ok)',
        color: stale ? 'var(--warn)' : 'var(--ok)',
      }}
    >
      Calibrated: the go/no-go gate was passed by {gate.status?.decided_by} on {decided}
      {correlation !== null && correlation !== undefined
        && `, with a rank correlation of ${correlation}`}.
      {stale && (
        <>
          {' '}
          <strong>Settings have changed since.</strong> {gate.status?.configNote}
        </>
      )}
      {unknownConfig && (
        <span style={{ color: 'var(--text-muted)' }}> {gate.status?.configNote}</span>
      )}
    </p>
  )
}
