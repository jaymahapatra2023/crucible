import { FormField, Select, TextInput } from './FormField.js'
import { BUILD_METHODS, type SubmissionDraft } from '../lib/submitApi.js'

/**
 * How a team says their project builds (E03-S01).
 *
 * Worth its own component because it is the field teams most often get wrong, and getting it
 * wrong is the difference between a probe reporting RUNS and one reporting BUILD_FAILED. The
 * hint says so plainly rather than leaving a team to find out after the deadline.
 */
export function BuildFields({
  draft, onChange,
}: {
  draft: SubmissionDraft
  onChange: <K extends keyof SubmissionDraft>(key: K, value: SubmissionDraft[K]) => void
}) {
  return (
    <>
      <FormField id="t-build" label="How your project builds" required
        hint="This is how we try to run it. Getting it right is the difference between 'runs' and 'could not be built'.">
        <Select id="t-build" value={draft.buildMethod} options={BUILD_METHODS}
          onChange={(e) => onChange('buildMethod', e.target.value as SubmissionDraft['buildMethod'])} />
      </FormField>

      {draft.buildMethod === 'DOCKERFILE' ? (
        <FormField id="t-dockerfile" label="Dockerfile path" required
          hint="Relative to the repository root.">
          <TextInput id="t-dockerfile" value={draft.dockerfilePath ?? ''}
            onChange={(e) => onChange('dockerfilePath', e.target.value)} />
        </FormField>
      ) : (
        <FormField id="t-command" label="Build and start command" required
          hint="One shell command, run from the top of your repository — if your manifest is in a
                subdirectory, begin with cd. Everything needed to install, build and start it.">
          <TextInput id="t-command" value={draft.buildCommand ?? ''}
            placeholder="npm ci && npm run build && npm start"
            onChange={(e) => onChange('buildCommand', e.target.value)} />
        </FormField>
      )}
    </>
  )
}

/** The intake window, stated before a team fills anything in. */
export function IntakeBanner({
  state, message, closesAt,
}: {
  state: string
  message: string
  closesAt: string | null
}) {
  const open = state === 'OPEN'
  return (
    <p role="status" style={{
      border: `1px solid ${open ? 'var(--ok)' : 'var(--warn)'}`,
      borderRadius: 8, padding: '10px 12px',
      color: open ? 'var(--text)' : 'var(--warn)',
    }}>
      <strong>{state}</strong> — {message}
      {closesAt && open && <> Entries close {new Date(closesAt).toLocaleString()}.</>}
    </p>
  )
}

/**
 * Things that look wrong but are not enforced.
 *
 * Visually distinct from the blocking panel and never a colour alone (P5.4): it is headed
 * "Worth checking" and the submit button stays enabled beside it.
 */
export function SubmissionWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <div role="status" data-testid="submit-warnings" style={{
      border: '1px solid var(--warn)', borderRadius: 8, padding: 12, marginBottom: 12,
    }}>
      <strong style={{ color: 'var(--warn)' }}>Worth checking — you can still submit</strong>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {warnings.map((w) => <li key={w}>{w}</li>)}
      </ul>
    </div>
  )
}

/** Problems a team must fix before the entry can be sent. */
export function SubmissionProblems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null
  return (
    <div role="alert" style={{
      border: '1px solid var(--danger)', borderRadius: 8, padding: 12, marginBottom: 12,
      background: '#fdf0ee',
    }}>
      <strong style={{ color: 'var(--danger)' }}>Not ready to submit</strong>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {problems.map((p) => <li key={p}>{p}</li>)}
      </ul>
    </div>
  )
}
