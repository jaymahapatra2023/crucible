import { Fragment, type ReactNode } from 'react'

/**
 * The shared table: sorting, paging and a real total (E40).
 *
 * Built after four tables had grown their own arrangements and the fifth was about to. Three
 * decisions are made here once, and each was learned the hard way somewhere else in this app:
 *
 *  1. **Fully controlled.** No state lives here. Changing a sort or a page changes what the page
 *     asks the server for, which blanks it to a loading state and unmounts this component — so
 *     state held inside would be silently discarded the instant it was used. That cost the roster
 *     a focused search box and the entries table a working filter before this existed.
 *  2. **Sorting is server-side, always.** A client sorting the 100 rows it was given out of 240
 *     sorts the wrong subset and presents a confident, wrong answer — "the strongest entry" when
 *     it is only the strongest of the first page. P5.7 exists for exactly this.
 *  3. **Only columns worth ordering are sortable.** A control that does nothing teaches an
 *     operator that controls do nothing. Sorting by a free-text detail sentence is not a feature.
 */
export interface Column<T> {
  /** Stable key. When `sortKey` is set, this column is sortable and the server decides how. */
  key: string
  header: string
  /** The value the server sorts by, when this column can be ordered. */
  sortKey?: string
  render: (row: T) => ReactNode
  align?: 'left' | 'right'
}

export interface TableState {
  /** The server's sort key, or undefined for its default. */
  sort?: string
  page: number
  pageSize: number
  /** The REAL backend count, never the length of what was returned (P5.7). */
  total: number
}

export function DataTable<T>({
  caption, columns, rows, keyOf, state, busy, empty, renderRow, onSort, onPage,
}: {
  caption: string
  columns: ReadonlyArray<Column<T>>
  rows: readonly T[]
  keyOf: (row: T) => string | number
  state: TableState
  busy: boolean
  /** What to say when there are no rows. The caller knows whether a filter is responsible. */
  empty: ReactNode
  /**
   * Render the whole `<tr>`, for a row that is more than cells.
   *
   * The participant row expands into an edit form spanning every column, which a per-cell
   * renderer cannot express. The headers, sorting and paging still come from `columns`, so such
   * a table gets the same controls as any other rather than growing its own.
   */
  renderRow?: (row: T) => ReactNode
  onSort: (sortKey: string) => void
  onPage: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(state.total / Math.max(1, state.pageSize)))
  const first = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1
  /*
   * Derived from the rows actually rendered, NOT from the page size.
   *
   * `page * pageSize` is what the page would hold if it were full. A short page — the last one,
   * or any page the server trimmed — then reads "1–200 of 240" while one row is on screen, which
   * is the table describing a list it is not showing. The whole point of carrying a real total
   * is that the numbers beside it are true.
   */
  const last = state.total === 0 ? 0 : first + rows.length - 1

  if (rows.length === 0) {
    return <p style={{ color: 'var(--text-muted)' }}>{empty}</p>
  }

  return (
    <>
      <div className="table-wrap">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key} scope="col"
                // The sorted column is announced, not merely underlined (P5.4, P5.5).
                aria-sort={ariaSort(column, state.sort)}
                style={{ ...HEAD, textAlign: column.align ?? 'left' }}
              >
                {column.sortKey === undefined ? column.header : (
                  <button
                    type="button" disabled={busy}
                    onClick={() => onSort(column.sortKey!)}
                    style={{
                      font: 'inherit', background: 'none', border: 'none', padding: 0,
                      cursor: 'pointer', color: 'inherit',
                      fontWeight: state.sort === column.sortKey ? 700 : 'inherit',
                    }}
                  >
                    {column.header}
                    {state.sort === column.sortKey && <span aria-hidden="true"> ▾</span>}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => renderRow
            ? <Fragment key={keyOf(row)}>{renderRow(row)}</Fragment>
            : (
              <tr key={keyOf(row)}>
                {columns.map((column) => (
                  <td key={column.key} style={{ ...CELL, textAlign: column.align ?? 'left' }}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
      </div>

      <Pager
        first={first} last={last} total={state.total} page={state.page} pages={pages}
        busy={busy} onPage={onPage}
      />
    </>
  )
}

/**
 * Where you are in the list, said in rows rather than page numbers.
 *
 * "41–60 of 240" answers the question an operator actually has. "Page 3 of 12" requires them to
 * multiply, and silently misleads the moment the page size changes.
 */
export function Pager({
  first, last, total, page, pages, busy, onPage,
}: {
  first: number
  last: number
  total: number
  page: number
  pages: number
  busy: boolean
  onPage: (page: number) => void
}) {
  return (
    <nav
      aria-label="Pages" data-testid="pager"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
        fontSize: 12, color: 'var(--text-muted)',
      }}
    >
      <span>
        {first}–{last} of {total}
      </span>
      {pages > 1 && (
        <>
          <button type="button" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>
            Previous
          </button>
          <span>Page {page} of {pages}</span>
          <button type="button" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>
            Next
          </button>
        </>
      )}
    </nav>
  )
}

const ariaSort = <T,>(column: Column<T>, sort?: string): 'none' | 'other' | undefined =>
  column.sortKey === undefined ? undefined : column.sortKey === sort ? 'other' : 'none'

const HEAD: React.CSSProperties = {
  padding: '4px 8px', borderBottom: '2px solid var(--border)',
  fontSize: 12, color: 'var(--text-muted)',
}
const CELL: React.CSSProperties = {
  padding: '4px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top',
}
