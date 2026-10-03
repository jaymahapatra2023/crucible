/**
 * The review screen: the ranked field, filtered, with the shortlist state (E08-S01, E08-S05).
 *
 * Filtering is done by refetching rather than by filtering rows in the browser, because a
 * client-side filter produces a count that describes the page instead of the field — the
 * dishonesty E08-S06 exists to prevent, arrived at by a different route.
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  finaliseShortlist, getReviewTable, getShortlist,
  type ReviewTable, type ShortlistState, type TableFilter,
} from '../lib/reviewApi.js'
import { DownloadButton } from '../components/DownloadButton.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { ReviewTableView } from '../components/ReviewTableView.js'
import { ShortlistBar } from '../components/ShortlistBar.js'
import { GateBanner } from '../components/GateBanner.js'
import { getGate, type GateResponse } from '../lib/calibrationApi.js'
import { ReadinessChecklist } from '../components/ReadinessChecklist.js'
import { getReadiness, type ReadinessReport } from '../lib/readinessApi.js'

interface PageData {
  table: ReviewTable
  shortlist: ShortlistState | null
  gate: GateResponse
  readiness: ReadinessReport | null
}

export function ReviewPage() {
  const { runId } = useParams()
  const run = Number(runId)
  const [filter, setFilter] = useState<TableFilter>({})
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { state } = useAsyncData<PageData>(
    async () => {
      const table = await getReviewTable(run, filter)
      // A run with no shortlist yet is an ordinary state, not a failure.
      const shortlist = await getShortlist(run).catch(() => null)
      const gate = await getGate()
      // A run with no cohort key yet has no readiness to report; that is ordinary, not an error.
      const cohortKey = shortlist?.shortlist.name ?? ''
      const readiness = cohortKey === ''
        ? null
        : await getReadiness(cohortKey).catch(() => null)
      return { table, shortlist, gate, readiness }
    },
    [run, JSON.stringify(filter), reload],
  )

  async function onFinalise() {
    setBusy(true)
    setError(null)
    try {
      await finaliseShortlist(run)
      setReload((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The shortlist could not be finalised.')
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading the ranked field" />
  if (state.status === 'error') {
    return (
      <ErrorState
        title="The review table could not be loaded"
        message={state.error.message}
        detail={state.error.code}
        onRetry={() => setReload((n) => n + 1)}
      />
    )
  }

  const { table, shortlist, gate, readiness } = state.data

  return (
    <section>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Review · run {run}</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0' }}>
          The ranked field. Crucible orders and flags; every decision below is recorded as yours.
          {' '}
          <DownloadButton
            path={`/review/runs/${run}/shortlist.csv`}
            filename={`shortlist-run-${run}.csv`}
            label="Export shortlist"
            testId="export-shortlist"
          />
          {' · '}
          <Link to={`/review/runs/${run}/coach-sheets`}>Coach sheets</Link>
        </p>
      </header>

      {/* Whether these positions may be acted on at all (E11-S03). */}
      <GateBanner gate={gate} />

      {shortlist && (
        <ShortlistBar
          shortlist={shortlist}
          busy={busy}
          {...(error !== null && { error })}
          onFinalise={onFinalise}
        />
      )}

      {readiness && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ fontSize: 13, cursor: 'pointer' }}>
            Readiness: {readiness.ready
              ? 'every statement holds'
              : `${readiness.checks.filter((c) => c.status !== 'PASS').length} outstanding`}
          </summary>
          <div style={{ marginTop: 8 }}>
            <ReadinessChecklist report={readiness} />
          </div>
        </details>
      )}

      <Filters filter={filter} onChange={setFilter} counts={table.counts} />

      {table.rows.length === 0 ? (
        <EmptyState
          title="No submission matches this filter"
          explanation={`${table.totalUnfiltered} submissions were ranked in this run. Clear the filter to see them.`}
        />
      ) : (
        <ReviewTableView
          table={table}
          runId={run}
          // Sorting or filtering returns to the first page: page 3 of the old order is a
          // different set of rows, and staying there would silently skip some.
          onSort={(key) => setFilter({ ...filter, sort: key, offset: 0 })}
          onPage={(page) => setFilter({
            ...filter, offset: (page - 1) * (table.limit || 50),
          })}
        />
      )}
    </section>
  )
}

function Filters({
  filter, onChange, counts,
}: {
  filter: TableFilter
  onChange: (next: TableFilter) => void
  counts: ReviewTable['counts']
}) {
  const toggle = (key: 'bandOnly' | 'flaggedOnly') => () =>
    onChange({ ...filter, [key]: filter[key] ? undefined : true })

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '0 0 12px' }}>
      <label style={{ fontSize: 13 }}>
        <input type="checkbox" checked={filter.bandOnly === true} onChange={toggle('bandOnly')} />
        {' '}At the cut line ({counts.inCutBand})
      </label>
      <label style={{ fontSize: 13 }}>
        <input
          type="checkbox"
          checked={filter.flaggedOnly === true}
          onChange={toggle('flaggedOnly')}
        />
        {' '}With open caveats ({counts.withOpenFlags})
      </label>
      <label style={{ fontSize: 13 }}>
        Decision{' '}
        <select
          value={filter.decision ?? ''}
          onChange={(e) => onChange({
            ...filter,
            ...(e.target.value === '' ? { decision: undefined } : { decision: e.target.value }),
          })}
        >
          <option value="">any</option>
          <option value="SHORTLIST">shortlisted</option>
          <option value="EXCLUDE">excluded</option>
          <option value="HOLD">on hold</option>
        </select>
      </label>
    </div>
  )
}
