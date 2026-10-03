import { useState } from 'react'
import type { FlaggedProvenance } from '../lib/eventApi.js'

/**
 * Flagged commit histories, as a list a person can work through (E19-S03).
 *
 * The framing E04-S06 insists on is the whole point and is repeated here because it is the thing
 * most easily lost: these are **flags, never exclusions**. Resolving one records what a person
 * concluded. Nothing here removes a submission, and there is deliberately no control that could.
 *
 * A resolved entry stays in the list, marked. A reader must be able to tell "somebody looked and
 * was satisfied" from "nobody has looked yet" — the same distinction the discovery tiles and the
 * non-scores exist to protect.
 */
export function ProvenanceQueue({
  entries, busy, onResolve,
}: {
  entries: FlaggedProvenance[]
  busy: boolean
  onResolve?: (submissionId: number, reason: string) => void
}) {
  const open = entries.filter((e) => !e.resolved).length

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16 }}>Commit histories to look at</h2>

      {entries.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          Nothing in any commit history has been flagged. Note that flagging needs an event
          window to be set, so this is also what you would see if that is still unconfigured.
        </p>
      ) : (
        <>
          <p style={{ color: 'var(--text-muted)' }}>
            {open === 0
              ? `All ${entries.length} flagged histories have been looked at.`
              : `${open} of ${entries.length} still to look at.`}{' '}
            These are prompts for a person. Nothing here excludes a submission.
          </p>
          {entries.map((entry) => (
            <QueueRow key={entry.submission_id} entry={entry} busy={busy} {...(onResolve && { onResolve })} />
          ))}
        </>
      )}
    </section>
  )
}

function QueueRow({
  entry, busy, onResolve,
}: {
  entry: FlaggedProvenance
  busy: boolean
  onResolve?: (submissionId: number, reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const usable = reason.trim().length >= 10

  return (
    <article
      data-testid={`provenance-${entry.submission_id}`}
      data-resolved={entry.resolved === true}
      style={{
        border: '1px solid var(--border)',
        borderLeft: `4px solid ${entry.resolved ? 'var(--ok)' : 'var(--warn)'}`,
        borderRadius: 8, padding: 12, marginBottom: 10, background: 'var(--surface)',
        opacity: entry.resolved ? 0.7 : 1,
      }}
    >
      <header style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>Submission {entry.submission_id}</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {entry.total_commits} commits · {entry.distinct_authors} author
          {entry.distinct_authors === 1 ? '' : 's'} ·{' '}
          largest single commit {entry.largest_single_commit_pct}%
          {entry.commits_out_of_window > 0
            && ` · ${entry.commits_out_of_window} outside the window`}
        </span>
        {entry.resolved && (
          <span style={{ color: 'var(--ok)', fontSize: 13, fontWeight: 600 }}>Looked at</span>
        )}
      </header>

      <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
        {entry.flags.map((f) => <li key={f.code}>{f.message}</li>)}
      </ul>

      {entry.history_truncated && (
        <p style={{ margin: '8px 0 0', color: 'var(--text-muted)' }}>
          The history was longer than the scan read, so these figures cover only part of it.
        </p>
      )}

      {entry.resolved ? (
        <p style={{ margin: '8px 0 0' }}>
          <strong>Concluded</strong>
          {entry.resolved_by && (
            <span style={{ color: 'var(--text-muted)' }}> by {entry.resolved_by}</span>
          )}
          : {entry.resolution_reason}
        </p>
      ) : !onResolve ? (
        <p style={{ margin: '8px 0 0', color: 'var(--text-muted)' }}>Not yet concluded.</p>
      ) : (
        <form
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault()
            if (usable) { onResolve(entry.submission_id, reason.trim()); setReason('') }
          }}
        >
          <label htmlFor={`resolve-${entry.submission_id}`}
            style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
            What did you conclude?
          </label>
          <textarea
            id={`resolve-${entry.submission_id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{
              width: '100%', minHeight: 56, padding: '6px 8px', font: 'inherit',
              border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--surface)', color: 'var(--text)',
            }}
          />
          <button type="submit" disabled={busy || !usable} style={{ marginTop: 6 }}>
            Record this
          </button>
        </form>
      )}
    </article>
  )
}
