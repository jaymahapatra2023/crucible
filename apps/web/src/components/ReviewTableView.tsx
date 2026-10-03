/**
 * The ranked field, one row per team (E08-S01, E08-S06).
 *
 * Two rules this component follows without exception:
 *
 *  - Every count comes from the backend. `rows.length` is never shown as a total, because a
 *    bounded fetch makes that a lie exactly when it matters and never while testing.
 *  - The cut-line band is visually distinct (acceptance 3), and so is an unscoreable dimension:
 *    a blank cell where a reviewer expects a number reads as zero.
 */
import { Link } from 'react-router-dom'
import { Pager } from './DataTable.js'
import type { ReviewRow, ReviewTable } from '../lib/reviewApi.js'

const DIMENSIONS = [
  ['CHALLENGE_FIDELITY', 'Fid'],
  ['ENGINEERING_QUALITY', 'Eng'],
  ['PRINCIPLES_STANDARDS', 'P&S'],
  ['RUNS', 'Runs'],
  ['ORIGINALITY', 'Orig'],
] as const

export function ReviewTableView({
  table, runId, onSort, onPage,
}: {
  table: ReviewTable
  runId: number
  onSort?: (key: string) => void
  /**
   * Move to another page (E40).
   *
   * The server has supported `limit`/`offset` since E08 and nothing ever sent an offset, so a
   * field of two hundred was a first page with no way past it — the honest "Showing 50 of 200"
   * told you what you were missing without letting you reach it.
   */
  onPage?: (page: number) => void
}) {
  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px' }}>
        {/* Backend counts, both of them, so "X of Y" is truthful (S06 acceptance 1). */}
        <span data-testid="showing-count">
          Showing {table.rows.length} of {table.total}
        </span>
        {table.total !== table.totalUnfiltered && ` matching (${table.totalUnfiltered} in total)`}
        {'. '}
        <span data-testid="band-count">{table.counts.inCutBand} at the cut line</span>
        {', '}
        <span data-testid="flagged-count">{table.counts.withOpenFlags} with open caveats</span>
        {', '}
        <span data-testid="decided-count">{table.counts.decided} decided</span>.
      </p>

      <table>
        <thead>
          <tr>
            <SortHeader label="Rank" sortKey="rank" table={table} onSort={onSort} />
            <SortHeader label="Team" sortKey="team" table={table} onSort={onSort} />
            <SortHeader label="Ch." sortKey="challenge" table={table} onSort={onSort} />
            <SortHeader label="Composite" sortKey="composite" table={table} onSort={onSort} />
            {DIMENSIONS.map(([key, label]) => (
              <SortHeader key={key} label={label} sortKey={key} table={table} onSort={onSort} />
            ))}
            <SortHeader label="Caveats" sortKey="flags" table={table} onSort={onSort} />
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => <Row key={row.submission_id} row={row} runId={runId} />)}
        </tbody>
      </table>

      {onPage && (
        <Pager
          // Rows, not page numbers: the offset arithmetic is the table's job, not the reader's.
          first={table.total === 0 ? 0 : table.offset + 1}
          last={table.total === 0 ? 0 : table.offset + table.rows.length}
          total={table.total}
          page={Math.floor(table.offset / Math.max(1, table.limit)) + 1}
          pages={Math.max(1, Math.ceil(table.total / Math.max(1, table.limit)))}
          busy={false}
          onPage={onPage}
        />
      )}
    </>
  )
}

/**
 * A sortable column heading.
 *
 * Sorting refetches rather than reordering the rows in hand: reordering a page sorts the page,
 * which looks identical and is wrong the moment the field is larger than the page.
 */
function SortHeader({
  label, sortKey, table, onSort,
}: {
  label: string
  sortKey: string
  table: ReviewTable
  onSort?: (key: string) => void
}) {
  const active = table.sort === sortKey

  if (!onSort) return <th scope="col">{label}</th>

  return (
    <th scope="col" aria-sort={active ? 'descending' : 'none'}>
      <button
        type="button"
        data-testid={`sort-${sortKey}`}
        onClick={() => onSort(sortKey)}
        style={{
          border: 'none', background: 'none', font: 'inherit',
          fontWeight: active ? 700 : 'inherit', cursor: 'pointer', padding: 0,
        }}
      >
        {label}{active ? ' ▾' : ''}
      </button>
    </th>
  )
}

function Row({ row, runId }: { row: ReviewRow; runId: number }) {
  const byDimension = new Map(row.dimensions.map((d) => [d.dimension, d]))

  return (
    <tr
      data-testid={`row-${row.submission_id}`}
      data-band={row.in_cut_band ? 'true' : 'false'}
      style={row.in_cut_band
        // The band is where a person's judgement changes the outcome, so it is legible at a
        // glance rather than needing a column to be read.
        ? { background: 'var(--surface-2)', borderLeft: '3px solid var(--warn)' }
        : undefined}
    >
      <td>
        {row.rank_global}
        {row.tied && <span style={{ color: 'var(--warn)' }} title="Tied composite"> ≡</span>}
      </td>
      <td>
        <Link to={`/review/runs/${runId}/teams/${row.submission_id}`}>
          {row.team_name ?? `#${row.submission_id}`}
        </Link>
      </td>
      <td>{row.challenge_id}</td>
      <td>{Number(row.composite).toFixed(1)}</td>

      {DIMENSIONS.map(([key]) => {
        const cell = byDimension.get(key)
        return (
          <td key={key} data-testid={`dim-${row.submission_id}-${key}`}>
            {cell === undefined || cell.score === null ? (
              // Never blank and never zero: an unscored dimension says so.
              <span
                style={{ color: 'var(--text-muted)' }}
                title={cell?.weight === 0
                  ? 'This dimension carries no weight in the rubric.'
                  : 'Could not be scored; excluded from the composite.'}
              >
                {cell?.weight === 0 ? 'n/a' : '—'}
              </span>
            ) : (
              <>
                {Number(cell.score).toFixed(0)}
                {cell.dataQuality === 'PARTIAL' && (
                  <span style={{ color: 'var(--warn)' }} title="Scored on partial evidence">*</span>
                )}
              </>
            )}
          </td>
        )
      })}

      <td>
        {row.open_flags > 0
          ? <strong style={{ color: 'var(--warn)' }}>{row.open_flags}</strong>
          : <span style={{ color: 'var(--text-muted)' }}>0</span>}
        {row.advisory_decided && (
          <span title="Position depends on the advisory dimension" style={{ color: 'var(--warn)' }}>
            {' '}⚑
          </span>
        )}
      </td>

      <td title={row.decision_reason ?? undefined}>
        {row.decision ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </td>
    </tr>
  )
}
