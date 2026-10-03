import { useState } from 'react'
import { csvDocument } from '@crucible/contracts'
import type { BulkPlan, BulkRow } from '../lib/intakeApi.js'

/**
 * Registering a whole cohort from one file (E20).
 *
 * One form per team is fifty form-fills and fifty copy-pastes for a fifty-team event, each of
 * which shows a plaintext token exactly once. This is the same operation in one step.
 *
 * It is deliberately TWO steps on screen. The check writes nothing and says what would happen —
 * which rows are new, which match a team that already exists, which cannot be acted on — because
 * the alternative is finding out after fifty teams exist. Only then is there a button that
 * registers them.
 *
 * The file and the result are held by the PAGE, not here. The intake page blanks to a loading
 * state whenever it refetches, which unmounts this panel — and an unmounted panel takes the only
 * copy of every issued plaintext with it. That is the one failure this whole path exists to
 * avoid, so the state lives where a refetch cannot reach it.
 */
export function BulkTokenPanel({
  csv, plan, busy, failure, onCsvChange, onRun, onRunForTeams, onSaved,
}: {
  csv: string
  plan: BulkPlan | null
  busy: boolean
  failure: string | null
  onCsvChange: (csv: string) => void
  onRun: (confirm: boolean) => void
  /** Issue for the teams that already exist, with no file (E29-S01). */
  onRunForTeams: (confirm: boolean) => void
  /** Called once the tokens are safely in a file, and not before. */
  onSaved: () => void
}) {
  const blocked = plan === null ? 0 : plan.summary.invalid + plan.summary.duplicate
  const fromTeams = builtFromTeams(plan)

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 20,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Register a cohort from a file</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        One row per team, with a header naming <code>team_name</code> and{' '}
        <code>contact_email</code>. Paste it below, check it, then register. Checking writes
        nothing.
      </p>

      <ForTeams plan={fromTeams ? plan : null} busy={busy} onRun={onRunForTeams} />

      <label htmlFor="bulk-csv" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        Teams
      </label>
      <textarea
        id="bulk-csv" rows={7} value={csv}
        onChange={(e) => onCsvChange(e.target.value)}
        placeholder={'team_name,contact_email\nThe Night Shift,night@example.com'}
        style={{
          width: '100%', font: '13px var(--mono, monospace)', padding: 8,
          border: '1px solid var(--border)', borderRadius: 6, boxSizing: 'border-box',
        }}
      />

      <p style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" disabled={busy || csv.trim() === ''} onClick={() => onRun(false)}>
          {busy ? 'Working…' : 'Check the file'}
        </button>
        {plan && !plan.issued && (
          <button type="button" disabled={busy || blocked > 0} onClick={() => onRun(true)}>
            Register {plan.summary.total} team{plan.summary.total === 1 ? '' : 's'}
          </button>
        )}
        {plan && !plan.issued && blocked > 0 && (
          <span style={{ color: 'var(--text-muted)' }}>
            Fix the {blocked} row{blocked === 1 ? '' : 's'} below first.
          </span>
        )}
      </p>

      {failure && <p role="alert" style={{ color: 'var(--danger)' }}>{failure}</p>}

      {plan && <Result plan={plan} onSaved={onSaved} />}
    </section>
  )
}

function Result({ plan, onSaved }: { plan: BulkPlan; onSaved: () => void }) {
  return (
    <>
      {plan.issued && <Issued plan={plan} onSaved={onSaved} />}
      {plan.refusal && (
        <p role="alert" style={{ color: 'var(--danger)' }}>{plan.refusal}</p>
      )}
      <p role="status" style={{ color: 'var(--text-muted)' }}>
        {plan.issued ? 'Registered' : 'Would register'} {plan.summary.new} new
        {' '}and replace the token for {plan.summary.existing} existing.
        {plan.summary.invalid > 0 && <> {plan.summary.invalid} cannot be read.</>}
        {plan.summary.duplicate > 0 && <> {plan.summary.duplicate} appear twice.</>}
      </p>
      <PlanTable rows={plan.rows} />
    </>
  )
}

/**
 * The tokens, and the one chance to keep them.
 *
 * Only the SHA-256 is stored, so this response is the only place the plaintexts will ever exist.
 * The download is built from what is already in memory rather than fetched, because there is no
 * endpoint that could serve it again — that is the whole point of storing only the hash.
 */
function Issued({ plan, onSaved }: { plan: BulkPlan; onSaved: () => void }) {
  const [saved, setSaved] = useState(false)

  function save() {
    // The shared writer, so this file is byte-identical to the one the server renders for the
    // same plan — including the formula neutralisation, since a team name is untrusted text and
    // this file is opened in a spreadsheet by definition.
    const body = csvDocument(
      ['team_name', 'contact_email', 'token', 'status'],
      plan.rows.map((r) => [
        r.teamName, r.contactEmail, r.token ?? '',
        r.outcome === 'EXISTING' ? 'replacement' : 'new',
      ]),
    )

    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'crucible-team-tokens.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    setSaved(true)
    // Only now is it safe to let the page refresh: doing it at issue time would unmount this
    // panel and destroy the only copy of these tokens.
    onSaved()
  }

  return (
    <div role="status" style={{
      border: '1px solid var(--warn)', borderRadius: 8, padding: 12, margin: '12px 0',
      background: 'var(--bg)',
    }}>
      <strong>
        {plan.summary.total} token{plan.summary.total === 1 ? '' : 's'} issued. Save them now.
      </strong>
      <p style={{ margin: '6px 0' }}>
        Only their hashes are stored, so this is the only time they can be read. Leaving this page
        without saving means issuing them all again.
      </p>
      <p style={{ margin: 0 }}>
        <button type="button" onClick={save}>Download the tokens</button>
        {saved && <span style={{ color: 'var(--text-muted)' }}> · saved</span>}
      </p>
    </div>
  )
}

const TONE: Record<BulkRow['outcome'], string> = {
  NEW: 'var(--ok)',
  EXISTING: 'var(--accent, var(--text-muted))',
  INVALID: 'var(--danger)',
  DUPLICATE: 'var(--danger)',
}

/** Every row, including the ones that are fine — "nothing wrong" has to be visible too. */
function PlanTable({ rows }: { rows: BulkRow[] }) {
  return (
    <table aria-label="Teams in this file">
      <thead>
        <tr>
          <th scope="col">Line</th><th scope="col">Team</th>
          <th scope="col">Contact</th><th scope="col">What happens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.line}>
            <td style={{ color: 'var(--text-muted)' }}>{row.line}</td>
            <td>{row.teamName || <em style={{ color: 'var(--text-muted)' }}>(blank)</em>}</td>
            <td style={{ color: 'var(--text-muted)' }}>{row.contactEmail}</td>
            <td>
              {/* The word, not only the colour (P5.5). */}
              <span style={{ color: TONE[row.outcome], fontWeight: 600 }}>{label(row)}</span>
              {row.detail && <div style={{ color: 'var(--text-muted)' }}>{row.detail}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function label(row: BulkRow): string {
  switch (row.outcome) {
    case 'NEW': return row.token ? 'registered' : 'new team'
    case 'EXISTING': return row.token ? 'token replaced' : 'already registered'
    case 'INVALID': return 'cannot be read'
    case 'DUPLICATE': return 'appears twice'
  }
}

/**
 * Issue for the teams that already exist, with no file (E29-S01).
 *
 * Its own component so the panel stays one readable function, and so the "from the teams" path is
 * visibly distinct from the "from a file" one below it.
 */
function ForTeams({
  plan, busy, onRun,
}: {
  plan: BulkPlan | null
  busy: boolean
  onRun: (confirm: boolean) => void
}) {
  return (
    <p style={{
      borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 14,
      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <button type="button" disabled={busy} onClick={() => onRun(false)}>
        Check teams without a token
      </button>
      {plan !== null && !plan.issued && plan.summary.new > 0 && (
        <button type="button" disabled={busy} onClick={() => onRun(true)}>
          Issue {plan.summary.new} token{plan.summary.new === 1 ? '' : 's'}
        </button>
      )}
      <span style={{ color: 'var(--text-muted)' }}>
        Teams the roster has already built need no file. Paste one below only to create teams that
        do not exist yet.
      </span>
    </p>
  )
}

/**
 * Whether a plan came from the teams rather than from a file.
 *
 * Every row of a team-built plan has line 0, because there was no file for it to have a line in.
 * The two paths must not be confused: issuing the wrong one hands out a token per team.
 */
const builtFromTeams = (plan: BulkPlan | null): boolean =>
  plan !== null && plan.rows.length > 0 && plan.rows.every((r) => r.line === 0)
