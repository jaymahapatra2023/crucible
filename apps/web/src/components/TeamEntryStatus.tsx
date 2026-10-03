import { useState } from 'react'
import {
  getMyEntry, type TeamEntry, type TeamView,
} from '../lib/submitApi.js'

/**
 * A team checking their own entry, with nothing but the token they already hold (E17-S03).
 *
 * Until now the only way to find out whether a submission was still valid was to email an
 * organiser and wait. A repository that went private after submission, or a commit force-pushed
 * away, is something a team can fix themselves — but only while they still know about it.
 *
 * The token scopes the read. There is no field here for naming a team, because there is no such
 * parameter on the endpoint: what you can see is what your token is.
 */
export function TeamEntryStatus({ token }: { token: string }) {
  const [view, setView] = useState<TeamView | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const look = async () => {
    setBusy(true)
    setFailure(null)
    try {
      setView(await getMyEntry(token))
    } catch (err) {
      setView(null)
      setFailure(err instanceof Error ? err.message : 'Your entry could not be looked up.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 20,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Check an entry you already sent</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Paste your token above and look it up. If something has gone wrong with your repository
        since you submitted, this is where it says so — and what to do about it.
      </p>

      <button type="button" disabled={busy || token.trim() === ''} onClick={() => void look()}>
        {busy ? 'Looking…' : 'Check my entry'}
      </button>
      {token.trim() === '' && (
        <span style={{ color: 'var(--text-muted)', marginLeft: 10 }}>
          Enter your submission token first.
        </span>
      )}

      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {view && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong>{view.team.displayName}</strong> — {view.message}
          </p>
          {view.entries.map((e) => <EntryCard key={e.submissionId} entry={e} />)}
        </div>
      )}
    </section>
  )
}

function EntryCard({ entry }: { entry: TeamEntry }) {
  const wrong = entry.remedy !== null
  return (
    <div style={{
      border: `1px solid ${wrong ? 'var(--warn)' : 'var(--ok)'}`, borderRadius: 8,
      padding: 12, marginBottom: 10, background: 'var(--bg)',
    }}>
      <p style={{ marginTop: 0 }}>
        <strong>{entry.challengeName}</strong>
        {entry.version > 1 && <> · version {entry.version}</>}
        {/* Never colour alone (P5.5): the state is named, not only tinted. */}
        <> · </>
        <span>{wrong ? 'needs your attention' : 'accepted'}</span>
      </p>
      <p style={{ margin: '4px 0' }}><strong>Repository: </strong>{entry.repoUrl}</p>
      {entry.lockedCommitSha ? (
        <p style={{ margin: '4px 0' }}>
          <strong>Commit locked: </strong><code>{entry.lockedCommitSha}</code>
          <br />
          <span style={{ color: 'var(--text-muted)' }}>
            This exact commit is what will be evaluated. Later pushes do not change it.
          </span>
        </p>
      ) : (
        <p style={{ margin: '4px 0', color: 'var(--warn)' }}>No commit has been locked yet.</p>
      )}
      {entry.submittedOnTheirBehalf && (
        <p style={{ margin: '4px 0', color: 'var(--text-muted)' }}>
          This entry was recorded by an organiser on your behalf.
        </p>
      )}
      {entry.remedy && (
        <p role="status" style={{ margin: '8px 0 0' }}>
          <strong>{entry.validationStatus}: </strong>{entry.remedy}
        </p>
      )}
    </div>
  )
}
