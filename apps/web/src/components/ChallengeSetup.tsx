import { useState } from 'react'
import { Link } from 'react-router-dom'
import { FormField, TextArea, TextInput } from './FormField.js'
import type { Artifact, RubricSummary } from '../lib/challengeApi.js'

/**
 * Creating a challenge (E02-S01).
 *
 * Deliberately two fields. Everything else a rubric needs comes out of the brief, and asking an
 * organiser to restate it here would create a second description that drifts from the document
 * the criteria actually cite.
 */
export function NewChallengeForm({
  busy, onCreate, onCancel,
}: {
  busy: boolean
  onCreate: (input: { name: string; description: string }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const ready = name.trim().length >= 3

  return (
    <form
      style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 16, margin: '14px 0' }}
      onSubmit={(e) => { e.preventDefault(); if (ready) onCreate({ name, description }) }}
    >
      <h2 style={{ fontSize: 15, marginTop: 0 }}>New challenge</h2>
      <FormField id="c-name" label="Name" required>
        <TextInput id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField id="c-desc" label="Description"
        hint="A sentence for the list. The brief you upload next is what criteria are derived from.">
        <TextArea id="c-desc" value={description}
          onChange={(e) => setDescription(e.target.value)} />
      </FormField>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !ready}>
          {busy ? 'Creating…' : 'Create challenge'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

const STATUS_TONE: Record<string, string> = {
  EXTRACTED: 'var(--ok)', PENDING: 'var(--text-muted)',
  FAILED: 'var(--danger)', UNSUPPORTED: 'var(--warn)',
}

/**
 * The briefs uploaded to a challenge, and whether their text could be read.
 *
 * Extraction status is shown per artefact rather than as one summary. A brief whose text could
 * not be extracted produces no criteria, and an organiser who does not notice will generate a
 * rubric from the documents that happened to work — without being told which those were.
 */
export function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        No brief uploaded yet. Criteria are derived from the brief, so this comes first.
      </p>
    )
  }

  return (
    <table>
      <thead>
        <tr>
          <th scope="col">File</th><th scope="col">Kind</th>
          <th scope="col">Text extraction</th>
        </tr>
      </thead>
      <tbody>
        {artifacts.map((a) => (
          <tr key={a.artifactId}>
            <td>{a.filename}</td>
            <td style={{ color: 'var(--text-muted)' }}>{a.kind}</td>
            <td style={{ color: STATUS_TONE[a.extractionStatus] ?? 'var(--text)' }}>
              {a.extractionStatus}
              {a.extractionError && (
                <span style={{ color: 'var(--text-muted)' }}> — {a.extractionError}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Rubrics generated for a challenge, newest first. */
export function RubricList({ rubrics }: { rubrics: RubricSummary[] }) {
  if (rubrics.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        No rubric yet. Generate one once the brief's text has been extracted — a rubric drawn
        from an unread brief would cite passages nobody can check.
      </p>
    )
  }

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {rubrics.map((r) => (
        <li key={r.rubricId} style={{
          border: '1px solid var(--border)', borderRadius: 8,
          padding: 10, marginBottom: 8, background: 'var(--surface)',
        }}>
          {/* `Link`, not `<a href>`: a plain anchor reloads the whole application, which
              throws away the session state the SPA is holding. */}
          <Link to={`/rubrics/${r.rubricId}`}>Version {r.version}</Link>
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
            {r.status} · {r.criteria.length} criteri{r.criteria.length === 1 ? 'on' : 'a'}
          </span>
        </li>
      ))}
    </ul>
  )
}
