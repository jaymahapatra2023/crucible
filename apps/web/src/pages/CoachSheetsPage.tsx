import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { getCoachSheets, sendCoachSheets, type CoachDispatch, type SheetScope } from '../lib/coachApi.js'
import { getUser } from '../lib/session.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { CoachSheetView } from '../components/CoachSheetView.js'
import { DownloadButton } from '../components/DownloadButton.js'

/** What happened, in a sentence: sent, prepared-only, and who could not be reached. */
export function describeOutcome(out: { sent: CoachDispatch[]; uncoached: string[] }): string {
  const sent = out.sent.filter((d) => d.status === 'SENT').length
  const prepared = out.sent.filter((d) => d.status === 'PREPARED').length
  const failed = out.sent.filter((d) => d.status === 'FAILED').length
  const coaches = (n: number) => `${n} coach${n === 1 ? '' : 'es'}`
  const parts: string[] = []
  if (sent > 0) parts.push(`${coaches(sent)} sent`)
  if (prepared > 0) parts.push(`${coaches(prepared)} prepared but not transmitted (no mail provider)`)
  if (failed > 0) parts.push(`${coaches(failed)} failed`)
  if (parts.length === 0) parts.push('Nothing was sent')
  return parts.join(', ') + (out.uncoached.length > 0 ? `. No coach on the roster for: ${out.uncoached.join(', ')}.` : '.')
}

/**
 * Every coach sheet for a run (E51): read here, print, or email each coach their own teams'.
 *
 * Scope is the shortlist once decisions exist, or the cut line before then — said on the page,
 * because a sheet sent for the wrong set of teams is a coach asking the wrong team the right
 * questions.
 */
export function CoachSheetsPage() {
  const { runId = '0' } = useParams()
  const run = Number(runId)
  const [search, setSearch] = useSearchParams()
  const scope = (search.get('scope') === 'cutline' ? 'cutline' : 'shortlist') as SheetScope
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const { state } = useAsyncData(() => getCoachSheets(run, scope), [run, scope, key])
  const role = getUser()?.role
  const organiser = role === 'organiser' || role === 'admin'

  if (state.status === 'loading') return <LoadingState label="Composing coach sheets" />
  if (state.status === 'error') {
    return <ErrorState title="Coach sheets could not be composed" message={state.error.message} onRetry={() => setKey((k) => k + 1)} />
  }
  const { sheets, dispatches } = state.data

  async function send() {
    setBusy(true); setFailure(null); setNotice(null)
    try {
      setNotice(describeOutcome(await sendCoachSheets(run, scope)))
      setKey((k) => k + 1)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'The sheets could not be sent.')
    } finally { setBusy(false) }
  }

  return (
    <section>
      <Toolbar run={run} scope={scope} organiser={organiser} busy={busy} canSend={sheets.length > 0}
        onScope={(v) => setSearch({ scope: v })} onSend={() => void send()} />
      <p className="no-print" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        {scope === 'shortlist'
          ? 'The teams with a SHORTLIST decision on this run. Before any decision is recorded, choose "inside the cut line".'
          : 'Every team inside the cut line of this run\'s ranking.'}
        {' '}The coach\'s copy carries findings and questions only — no rank, no decision.
        {dispatches.length > 0 && <> Last sent to {dispatches.length} coach{dispatches.length === 1 ? '' : 'es'}.</>}
      </p>
      {notice && <p role="status" className="no-print">{notice}</p>}
      {failure && <p role="alert" className="no-print" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {sheets.length === 0 ? (
        <EmptyState title="No teams in scope" explanation={scope === 'shortlist' ? 'Nothing is shortlisted on this run yet.' : 'Nobody is inside the cut line.'} />
      ) : sheets.map((s) => <CoachSheetView key={s.submissionId} sheet={s} showStanding={organiser} />)}
    </section>
  )
}

function Toolbar({ run, scope, organiser, busy, canSend, onScope, onSend }: {
  run: number; scope: SheetScope; organiser: boolean; busy: boolean; canSend: boolean
  onScope: (v: string) => void; onSend: () => void
}) {
  return (
      <header className="no-print" style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Link to={`/review/runs/${run}`} style={{ fontSize: 12 }}>← Back to the ranked field</Link>
          <h1 style={{ fontSize: 19, margin: '4px 0 0' }}>Coach sheets · run #{run}</h1>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13 }}>
            Teams{' '}
            <select value={scope} onChange={(e) => onScope(e.target.value)} aria-label="Which teams">
              <option value="shortlist">shortlisted</option>
              <option value="cutline">inside the cut line</option>
            </select>
          </label>
          <button type="button" onClick={() => window.print()}>Print</button>
          {organiser && (
            <>
              <DownloadButton path={`/review/runs/${run}/coach-sheets.txt?scope=${scope}`}
                filename={`coach-sheets-run-${run}.txt`} label="Download (organiser copy)" testId="download-sheets" />
              <button type="button" disabled={busy || !canSend} onClick={onSend}>
                Email each coach their teams
              </button>
            </>
          )}
        </span>
      </header>
  )
}
