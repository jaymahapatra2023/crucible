import { useState } from 'react'
import { useAsyncData } from '../lib/useAsyncData.js'
import { getUser } from '../lib/session.js'
import { LoadingState } from '../components/LoadingState.js'
import { ErrorState } from '../components/ErrorState.js'
import { EmptyState } from '../components/EmptyState.js'
import { FormField, TextInput } from '../components/FormField.js'
import { GoldenSetBuilder } from '../components/GoldenSetBuilder.js'
import { LinkEntries } from '../components/LinkEntries.js'
import { HandRanking } from '../components/HandRanking.js'
import { GateCriteriaForm, GateDecision } from '../components/GatePanel.js'
import { GateBanner } from '../components/GateBanner.js'
import {
  addGoldenEntry, createGoldenSet, generateReport, getGate, getGateCriteria, getGoldenSet,
  getGoldenSets, getRankings, linkGoldenSet, recordDecision, recordGateCriteria, recordRanking,
  sealGoldenSet,
  type CalibrationReport, type GateCriteria, type GateResponse, type LinkPlan,
  type GoldenSetDetail, type GoldenSetSummary, type RankingRow,
} from '../lib/calibrationApi.js'

interface PageData {
  sets: GoldenSetSummary[]
  detail: GoldenSetDetail | null
  rankings: RankingRow[]
  criteria: GateCriteria | null
  gate: GateResponse
}

/**
 * Whether this system is fit to eliminate anyone (E18-S02 … S04).
 *
 * The most consequential decision Crucible supports, and until now the least accessible: every
 * step of it was API-only. A gate that can only be exercised through curl is a gate that gets
 * skipped when the evening is tight, and skipping it is exactly what the design exists to
 * prevent.
 *
 * The page follows the order E11 requires, and the order is enforced rather than suggested:
 * assemble the set, rank it by hand independently, seal it, write down what passing means, and
 * only then produce the report and take the decision.
 */
export function CalibrationPage() {
  const [selected, setSelected] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [report, setReport] = useState<CalibrationReport | null>(null)
  const [linkPlan, setLinkPlan] = useState<LinkPlan | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const { state, reload } = useAsyncData<PageData>(
    async () => {
      const [sets, gate] = await Promise.all([getGoldenSets(), getGate()])
      const id = selected ?? sets[0]?.golden_set_id ?? null
      if (id === null) return { sets, detail: null, rankings: [], criteria: null, gate }

      const [detail, rankings, criteria] = await Promise.all([
        getGoldenSet(id),
        getRankings(id).then((r) => r.rankings).catch(() => [] as RankingRow[]),
        getGateCriteria(id).catch(() => null),
      ])
      return { sets, detail, rankings, criteria, gate }
    },
    [selected, reloadKey],
  )

  async function act(what: () => Promise<string>) {
    setBusy(true)
    setFailure(null)
    try {
      setNotice(await what())
      setReloadKey((n) => n + 1)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'That could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading calibration" />
  if (state.status === 'error') {
    return (
      <ErrorState title="Calibration could not be loaded" message={state.error.message}
        detail={state.error.code} onRetry={reload} />
    )
  }

  const { sets, detail, rankings, criteria, gate } = state.data

  return (
    <section>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 19, margin: 0 }}>Calibration</h1>
        <span style={{ color: 'var(--text-muted)' }}>
          Whether this system is fit to eliminate anyone, decided on evidence and recorded.
        </span>
        <button type="button" style={{ marginLeft: 'auto' }} disabled={busy}
          onClick={() => setCreating(true)}>
          New golden set
        </button>
      </header>

      <GateBanner gate={gate} />

      {notice && <p role="status" style={{ color: 'var(--ok)' }}>{notice}</p>}
      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {creating && (
        <form
          style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 16, margin: '14px 0' }}
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim().length < 3) return
            void act(async () => {
              const made = await createGoldenSet(name.trim(), '')
              setCreating(false); setName(''); setSelected(made.golden_set_id)
              return `${made.name} was created. Add repositories spanning the whole range.`
            })
          }}
        >
          <FormField id="gs-name" label="Name" required>
            <TextInput id="gs-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy}>Create</button>
            <button type="button" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}

      {sets.length > 1 && (
        <p>
          <label htmlFor="gs-pick" style={{ marginRight: 8 }}>Golden set</label>
          <select id="gs-pick" value={detail?.set.golden_set_id ?? ''}
            onChange={(e) => { setSelected(Number(e.target.value)); setLinkPlan(null) }}>
            {sets.map((s) => (
              <option key={s.golden_set_id} value={s.golden_set_id}>{s.name}</option>
            ))}
          </select>
        </p>
      )}

      {detail === null ? (
        <EmptyState
          title="No golden set yet"
          explanation={
            'A calibration compares this system against people. That needs a set of repositories '
            + 'whose relative quality is already known, ranked by hand before any machine sees '
            + 'them.'}
          action={<button type="button" onClick={() => setCreating(true)}>New golden set</button>}
        />
      ) : (
        <>
          <GoldenSetBuilder
            detail={detail} busy={busy}
            onAdd={(entry) => void act(async () => {
              await addGoldenEntry(detail.set.golden_set_id, entry)
              return `${entry.label} was added.`
            })}
            onSeal={() => void act(async () => {
              await sealGoldenSet(detail.set.golden_set_id)
              return 'The set is sealed. The gate decision will rest on exactly this.'
            })}
          />

          <LinkEntries
            plan={linkPlan} busy={busy}
            onCheck={() => void act(async () => {
              const plan = await linkGoldenSet(detail.set.golden_set_id, false)
              setLinkPlan(plan)
              return plan.summary.unresolved === 0
                ? 'Every entry has a submission behind it.'
                : `${plan.summary.unresolved} entries have nothing to compare against.`
            })}
            onLink={() => void act(async () => {
              const plan = await linkGoldenSet(detail.set.golden_set_id, true)
              setLinkPlan(plan)
              return plan.linked
                ? 'Linked. A report can be produced once the set is sealed.'
                : 'Nothing was linked — see what is unresolved below.'
            })}
          />

          <HandRanking
            detail={detail} mine={rankings} busy={busy}
            onRecord={(positions) => void act(async () => {
              // The signed-in person, not a placeholder: E11-S01 wants at least two people
              // ranking independently, and that is only checkable if each ordering is
              // attributed to whoever actually made it.
              await recordRanking(
                detail.set.golden_set_id, getUser()?.email ?? 'unknown', positions)
              return 'Your ranking was recorded.'
            })}
          />

          {detail.set.status === 'SEALED' && criteria && report === null && (
            <ProduceReport
              busy={busy}
              onProduce={(runIndexId) => void act(async () => {
                setReport(await generateReport(detail.set.golden_set_id, runIndexId))
                return 'The report was produced. Record the decision below.'
              })}
            />
          )}

          <GateCriteriaForm
            existing={criteria} busy={busy}
            onRecord={(input) => void act(async () => {
              await recordGateCriteria(detail.set.golden_set_id, input)
              return 'Criteria recorded. A report can now be produced against them.'
            })}
          />

          {report && (
            <GateDecision
              report={report} criteria={criteria} busy={busy}
              onDecide={(decision, rationale) => void act(async () => {
                await recordDecision(report.report_id, decision, rationale)
                setReport(null)
                return `${decision} was recorded.`
              })}
            />
          )}
        </>
      )}
    </section>
  )
}

/**
 * Produce the report, once the set is sealed and the criteria are written down.
 *
 * Shown only in that order, because the server refuses any other — a report against an unsealed
 * set proves nothing about the machine, and one produced before the criteria invites the
 * criteria to be chosen after.
 */
function ProduceReport({
  busy, onProduce,
}: {
  busy: boolean
  onProduce: (runIndexId: number) => void
}) {
  const [runIndexId, setRunIndexId] = useState('')
  const id = Number(runIndexId)
  const ready = Number.isInteger(id) && id >= 1

  return (
    <form
      style={{
        border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 16,
        background: 'var(--surface)',
      }}
      onSubmit={(e) => { e.preventDefault(); if (ready) onProduce(id) }}
    >
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Produce the report</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Compares the machine ordering from a scoring run against the hand rankings, and reports
        every material disagreement with its evidence.
      </p>
      <FormField id="cr-run" label="Scoring run" required
        hint="The run that scored this golden set.">
        <TextInput id="cr-run" type="number" min="1" value={runIndexId}
          onChange={(e) => setRunIndexId(e.target.value)} />
      </FormField>
      <button type="submit" disabled={busy || !ready}>Produce it</button>
    </form>
  )
}
