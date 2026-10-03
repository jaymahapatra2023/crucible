import { useState } from 'react'
import { importRoster, ROSTER_KINDS, type ImportPlan, type RosterKind } from '../lib/rosterApi.js'

/**
 * Loading participants, rooms or coaches from a file (E27-S01, E27-S02, E28-S03).
 *
 * The same two steps as every other import here: check writes nothing and says what would happen,
 * then register. A file with any unusable row is refused whole, because importing the good rows
 * would leave somebody reconciling which of 200 people exist against a file that does not say.
 *
 * A `team_name` column on a participant file assigns as it imports, and the check states which
 * team each row would join and whether that team would have to be created — before it exists.
 */
const HINTS: Record<RosterKind, string> = {
  participant: 'full_name, email · optional: organisation, phone, team_name',
  room: 'label · optional: location, capacity',
  coach: 'full_name, email · optional: organisation',
}

export function RosterImportPanel({
  busy, onImported,
}: {
  busy: boolean
  onImported: () => void
}) {
  const [kind, setKind] = useState<RosterKind>('participant')
  const [csv, setCsv] = useState('')
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  async function run(confirm: boolean) {
    setWorking(true)
    setFailure(null)
    try {
      const result = await importRoster(kind, csv, confirm)
      setPlan(result)
      if (result.imported) { setCsv(''); onImported() }
    } catch (err) {
      setPlan(null)
      setFailure(err instanceof Error ? err.message : 'That file could not be read.')
    } finally {
      setWorking(false)
    }
  }

  const blocked = plan === null ? 0 : plan.summary.invalid + plan.summary.duplicate
  const disabled = busy || working

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 24,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Load a list</h2>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label htmlFor="import-kind" style={{ fontWeight: 600 }}>
          What is in this file
          <select
            id="import-kind" value={kind}
            onChange={(e) => { setKind(e.target.value as RosterKind); setPlan(null) }}
            style={{
              display: 'block', marginTop: 4, font: 'inherit', padding: '6px 8px',
              border: '1px solid var(--border)', borderRadius: 6,
            }}
          >
            {ROSTER_KINDS.map((k) => (
              <option key={k} value={k}>{k === 'participant' ? 'Participants' : `${k}s`}</option>
            ))}
          </select>
        </label>
        <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 12 }}>
          Header must name: <code>{HINTS[kind]}</code>
        </p>
      </div>

      <label htmlFor="import-csv" style={{ display: 'block', fontWeight: 600, margin: '10px 0 4px' }}>
        Rows
      </label>
      <textarea
        id="import-csv" rows={6} value={csv}
        onChange={(e) => { setCsv(e.target.value); setPlan(null) }}
        style={{
          width: '100%', font: '13px var(--mono, monospace)', padding: 8,
          border: '1px solid var(--border)', borderRadius: 6, boxSizing: 'border-box',
        }}
      />

      <Actions
        plan={plan} disabled={disabled} working={working} blocked={blocked}
        empty={csv.trim() === ''} onRun={(confirm) => void run(confirm)}
      />

      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}
      {plan?.refusal && <p role="alert" style={{ color: 'var(--danger)' }}>{plan.refusal}</p>}

      {plan && <Outcome plan={plan} />}
    </section>
  )
}

/**
 * Check, then load. Two buttons and a reason the second is disabled.
 *
 * Its own component because the panel had grown past what one function should decide, and this is
 * the part with the conditions in it.
 */
function Actions({
  plan, disabled, working, blocked, empty, onRun,
}: {
  plan: ImportPlan | null
  disabled: boolean
  working: boolean
  blocked: number
  empty: boolean
  onRun: (confirm: boolean) => void
}) {
  const pending = plan !== null && !plan.imported
  return (
    <p style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" disabled={disabled || empty} onClick={() => onRun(false)}>
        {working ? 'Working…' : 'Check the file'}
      </button>
      {pending && (
        <button type="button" disabled={disabled || blocked > 0} onClick={() => onRun(true)}>
          Load {plan.summary.new} new
        </button>
      )}
      {pending && blocked > 0 && (
        <span style={{ color: 'var(--text-muted)' }}>
          Fix the {blocked} row{blocked === 1 ? '' : 's'} below first.
        </span>
      )}
    </p>
  )
}

/** What the file would do, or did. Split out to keep the panel itself readable. */
function Outcome({ plan }: { plan: ImportPlan }) {
  return (
    <>
      <p role="status" style={{ color: 'var(--text-muted)' }}>
        {plan.imported ? 'Loaded' : 'Would load'} {plan.summary.new} new;
        {' '}{plan.summary.existing} already on the list.
        {plan.summary.invalid > 0 && <> {plan.summary.invalid} cannot be read.</>}
        {plan.summary.duplicate > 0 && <> {plan.summary.duplicate} appear twice.</>}
      </p>
      <PlanTable plan={plan} />
    </>
  )
}

const TONE: Record<ImportPlan['rows'][number]['outcome'], string> = {
  NEW: 'var(--ok)',
  EXISTING: 'var(--text-muted)',
  INVALID: 'var(--danger)',
  DUPLICATE: 'var(--danger)',
}

const LABEL: Record<ImportPlan['rows'][number]['outcome'], string> = {
  NEW: 'new',
  EXISTING: 'already listed',
  INVALID: 'cannot be read',
  DUPLICATE: 'appears twice',
}

function PlanTable({ plan }: { plan: ImportPlan }) {
  const showsTeams = plan.rows.some((r) => r.teamName !== null)

  return (
    <table aria-label="Rows in this file">
      <thead>
        <tr>
          <th scope="col">Line</th><th scope="col">Who</th>
          {showsTeams && <th scope="col">Team</th>}
          <th scope="col">What happens</th>
        </tr>
      </thead>
      <tbody>
        {plan.rows.map((row) => (
          <tr key={row.line}>
            <td style={{ color: 'var(--text-muted)' }}>{row.line}</td>
            <td>{row.label || <em style={{ color: 'var(--text-muted)' }}>(blank)</em>}</td>
            {showsTeams && (
              <td>
                {row.teamName ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
                {row.teamIsNew && (
                  <span style={{ color: 'var(--warn)' }}> · would be created</span>
                )}
              </td>
            )}
            <td>
              {/* The word, not only the colour (P5.5). */}
              <span style={{ color: TONE[row.outcome], fontWeight: 600 }}>{LABEL[row.outcome]}</span>
              {row.detail && <div style={{ color: 'var(--text-muted)' }}>{row.detail}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
