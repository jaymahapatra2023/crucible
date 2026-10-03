import { Link } from 'react-router-dom'
import { DataTable, type Column } from './DataTable.js'
import { PreflightCell } from './PreflightCell.js'
import {
  VALIDATION_STATUSES, type SubmissionPage, type SubmissionRow, type SubmissionSort,
  type ValidationStatus,
} from '../lib/intakeApi.js'

/**
 * Every entry, not only the failing ones (E39, paged in E40).
 *
 * The dashboard itemises failures and counts everything else, which makes a perfectly good
 * submission invisible: an organiser could see "12 valid" and still not answer "what did this
 * team submit?" without a database query.
 *
 * Fully controlled — filters, sort and page all live on the page. Changing any of them changes
 * what the page asks the server for, which unmounts this component; state held here would be
 * discarded the instant it was used.
 */
export interface EntryQuery {
  challengeId?: number
  status?: ValidationStatus
  sort?: SubmissionSort
  page?: number
}

export function SubmissionsTable({
  page, challengeNames, busy, query, onQuery, onRunPreflight,
}: {
  page: SubmissionPage
  /** Challenge id to name, so a row says "RealWorld Conduit" rather than "#9". */
  challengeNames: ReadonlyMap<number, string>
  busy: boolean
  query: EntryQuery
  onQuery: (next: EntryQuery) => void
  /** Queue tier 2 for one entry (E46). Absent for a reader who cannot trigger it. */
  onRunPreflight?: (submissionId: number, force: boolean) => void
}) {
  /** A filter change returns to page 1: page 7 of the old result set means nothing in the new. */
  const filter = (next: Partial<EntryQuery>) => onQuery({ ...query, ...next, page: 1 })

  const columns: ReadonlyArray<Column<SubmissionRow>> = [
    { key: 'team', header: 'Team', sortKey: 'team', render: (r) => r.teamName },
    {
      key: 'challenge', header: 'Challenge', sortKey: 'challenge',
      render: (r) => challengeNames.get(r.challengeId) ?? `#${r.challengeId}`,
    },
    {
      // Not sortable: a URL orders alphabetically by host, which answers nothing anybody asks.
      key: 'repo', header: 'Repository',
      render: (r) => (
        <a href={r.repoUrl} target="_blank" rel="noreferrer noopener">
          {r.repoUrl.replace(/^https:\/\/(www\.)?/, '')}
        </a>
      ),
    },
    {
      key: 'status', header: 'Status', sortKey: 'status',
      render: (r) => (
        <>
          {/* Written out, never colour alone (P5.4). The detail is the actionable half, and
              repeating it for a valid entry is noise beside the word VALID. */}
          <strong>{r.validationStatus}</strong>
          {r.validationDetail !== null && r.validationStatus !== 'VALID' && (
            <span style={{ color: 'var(--text-muted)' }}> — {r.validationDetail}</span>
          )}
        </>
      ),
    },
    {
      key: 'preflight', header: 'Pre-flight',
      render: (r) => <PreflightCell row={r} busy={busy} {...(onRunPreflight && { onRun: onRunPreflight })} />,
    },
    { key: 'version', header: 'Version', sortKey: 'version', align: 'right',
      render: (r) => r.version },
    {
      key: 'commit', header: 'Commit',
      render: (r) => r.lockedCommitSha
        ? <code>{r.lockedCommitSha.slice(0, 10)}</code>
        : <span style={{ color: 'var(--text-muted)' }}>not locked</span>,
    },
  ]

  const filtered = query.challengeId !== undefined || query.status !== undefined

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 15 }}>Entries</h2>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <label style={LABEL}>
          Challenge{' '}
          <select
            aria-label="Filter by challenge" disabled={busy} value={query.challengeId ?? ''}
            onChange={(e) => filter({
              challengeId: e.target.value === '' ? undefined : Number(e.target.value),
            })}
            style={CONTROL}
          >
            <option value="">All</option>
            {[...challengeNames].map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>

        <label style={LABEL}>
          Status{' '}
          <select
            aria-label="Filter by status" disabled={busy} value={query.status ?? ''}
            onChange={(e) => filter({
              status: e.target.value === '' ? undefined : e.target.value as ValidationStatus,
            })}
            style={CONTROL}
          >
            <option value="">All</option>
            {VALIDATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      <DataTable
        caption="Every current entry"
        columns={columns} rows={page.items} keyOf={(r) => r.submissionId} busy={busy}
        state={{
          ...(query.sort !== undefined && { sort: query.sort }),
          page: page.page, pageSize: page.pageSize, total: page.total,
        }}
        empty={filtered ? 'No entries match that filter.' : 'No entries yet.'}
        onSort={(sort) => onQuery({ ...query, sort: sort as SubmissionSort, page: 1 })}
        onPage={(next) => onQuery({ ...query, page: next })}
      />

      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0' }}>
        Commits are locked when intake closes, so <strong>not locked</strong> is the normal state
        until then. <Link to="/intake">Locking the window</Link> sets them.
      </p>
    </section>
  )
}

const LABEL: React.CSSProperties = { fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }
const CONTROL: React.CSSProperties = {
  font: 'inherit', fontSize: 13, padding: '3px 6px',
  border: '1px solid var(--border)', borderRadius: 6,
  background: 'var(--surface)', color: 'var(--text)',
}
