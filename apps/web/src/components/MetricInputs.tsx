/**
 * The measurements behind the engineering-quality score (E06-S04 acceptance 3).
 *
 * Shown beside the score rather than instead of it. The caption matters as much as the numbers:
 * a reviewer who reads "1,200 lines" as a quality signal has been misled by the UI, not by the
 * scorer, so the panel says plainly what the measurements are for.
 */
import type { MetricInputs as Inputs } from '../lib/scoringApi.js'

export function MetricInputsPanel({ inputs }: { inputs: Inputs | null }) {
  if (!inputs) {
    return (
      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        The scan this score was computed from is no longer available, so the measurements behind
        the engineering-quality score cannot be shown.
      </p>
    )
  }

  const m = inputs.metrics as Record<string, number | boolean | string[]>

  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>Measurements</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        What the scorer was given alongside the source. Size is context, not quality — a larger
        submission is not thereby a better one.
      </p>

      <dl style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 8, margin: 0, fontSize: 13,
      }}>
        <Metric label="Files analysed" value={`${inputs.filesAnalysed} of ${inputs.filesTotal}`} />
        <Metric label="Lines of code" value={String(m['codeLines'] ?? '—')} />
        <Metric label="Comment lines" value={String(m['commentLines'] ?? '—')} />
        <Metric label="Longest file" value={`${String(m['maxFileLines'] ?? '—')} lines`} />
        <Metric label="Tests" value={m['hasTests'] ? `${String(m['testFileCount'])} files` : 'none found'} />
        <Metric label="CI" value={m['hasCi'] ? 'configured' : 'none found'} />
        <Metric label="Dockerfile" value={m['hasDockerfile'] ? 'present' : 'none found'} />
        <Metric label="Dependencies" value={String(m['dependencyCount'] ?? '—')} />
        <Metric
          label="Languages"
          value={Array.isArray(m['languages']) && m['languages'].length > 0
            ? (m['languages'] as string[]).join(', ')
            : 'none detected'}
        />
      </dl>

      {inputs.budgetTruncated && (
        <p role="status" style={{ fontSize: 12, color: 'var(--warn)', marginTop: 8 }}>
          The scan did not read the whole repository, so these figures describe the files that
          were analysed rather than the repository as a whole.
        </p>
      )}

      {inputs.commitSha && (
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, fontFamily: 'monospace' }}>
          commit {inputs.commitSha.slice(0, 12)}
        </p>
      )}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>{value}</dd>
    </div>
  )
}
