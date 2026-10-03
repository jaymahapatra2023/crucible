import { useState } from 'react'
import { FormField, TextInput } from './FormField.js'
import { TeamEditControl } from './TeamEditControl.js'
import { SimilarWarning, StrandedTeams, useSimilarTeams } from './TokenPanelParts.js'
import type {
  IssuedToken, SubmissionToken, TeamListing, TokenSort,
} from '../lib/intakeApi.js'

/**
 * Issuing the tokens teams submit with (E03-S01, P8.2).
 *
 * Teams are not Crucible users by design — fifty accounts for one evening is all risk and no
 * benefit — so a team proves itself with a scoped, revocable token instead. This is where an
 * organiser mints one per team and sends it with the invitation.
 *
 * Only the SHA-256 is stored, so the plaintext exists exactly once: in the response to the call
 * that created it. The panel says so and keeps it on screen until dismissed, because there is no
 * way to recover it afterwards and a team lost at this moment means a team that cannot enter.
 *
 * Since E17-S01 the token IS the team: issuing one for a name nobody has used creates that team,
 * and issuing one for a team that already exists reissues against the same identity. Which of
 * the two is happening is stated before the button is pressed, because getting it wrong produces
 * a duplicate team nobody notices until the rankings have two of them.
 */
export function TokenPanel({
  tokens, teams, issued, busy, sort, onSort, onIssue, onReissue, onRevoke, onDismiss, onEditTeam,
  onReveal,
}: {
  tokens: SubmissionToken[]
  teams: TeamListing[]
  issued: IssuedToken | null
  busy: boolean
  /** Server-side ordering. Held by the page, because a refetch unmounts this panel. */
  sort?: TokenSort
  onSort?: (sort: TokenSort) => void
  /** Absent below organiser: the list reads, nothing issues (P8.2). */
  onIssue?: (input: { label: string; contactEmail: string }) => void
  /** Replace an existing team's code: revokes the old, shows the new once (E47-S01). */
  onReissue?: (teamId: number, reason: string) => void
  onRevoke?: (tokenId: number, label: string) => void
  onDismiss: () => void
  /** Correct a team's name or contact from its row (E48-S01). */
  onEditTeam?: (teamId: number, patch: { displayName?: string; contactEmail?: string }) => void
  /** Read a code back under audit (ADR 0005). Only an admin's page passes this. */
  onReveal?: (tokenId: number) => void
}) {
  const [label, setLabel] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [teamId, setTeamId] = useState(0)
  const [reason, setReason] = useState('')
  const similar = useSimilarTeams(teamId === 0 ? label : '')

  const reissuing = teamId !== 0
  const ready = reissuing
    ? reason.trim().length >= 3
    : label.trim().length >= 2 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail.trim())

  return (
    <section style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginTop: 20,
      background: 'var(--surface)',
    }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Submission tokens</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        One per team. Send it with the team's invitation along with the link to{' '}
        <a href="/submit">the submission page</a> — they need no account.
      </p>

      {issued && (
        <div role="status" style={{
          border: '1px solid var(--ok)', borderRadius: 8, padding: 12, marginBottom: 12,
          background: 'var(--bg)',
        }}>
          <strong>Token for {issued.teamName}</strong>
          <p style={{ margin: '6px 0' }}>
            <code style={{ fontSize: 14, wordBreak: 'break-all' }}>{issued.token}</code>
          </p>
          {issued.revealed && (
            <p style={{ margin: '0 0 6px' }}>
              This is the team's <strong>current</strong> code, read back under your name — the
              reveal is on the audit trail. Nothing changed for the team.
            </p>
          )}
          {issued.revoked !== undefined && issued.revoked > 0 && (
            <p style={{ margin: '0 0 6px' }}>
              <strong>The previous code has stopped working.</strong> Anything the team submits
              with it from now on is refused; send them this one.
            </p>
          )}
          <p style={{ margin: 0, color: 'var(--warn)' }}>
            Copy this now. Only its hash is stored, so it cannot be shown again — issue a new one
            if it is lost.
          </p>
          <p style={{ margin: '8px 0 0' }}>
            <button type="button" onClick={onDismiss}>I have copied it</button>
          </p>
        </div>
      )}

      <StrandedTeams teams={teams} />

      {onIssue && <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!ready) return
          if (reissuing) onReissue?.(teamId, reason.trim())
          else onIssue?.({ label: label.trim(), contactEmail: contactEmail.trim() })
          setLabel('')
          setContactEmail('')
          setReason('')
          setTeamId(0)
        }}
      >
        <FormField id="tk-team" label="Team"
          hint="Choose a team to issue a replacement token for one that already exists, or leave this as a new team and name them below.">
          <select id="tk-team" value={teamId} onChange={(e) => setTeamId(Number(e.target.value))}
            style={{
              width: '100%', padding: '6px 8px', font: 'inherit',
              border: '1px solid var(--border)', borderRadius: 6,
            }}>
            <option value={0}>A new team…</option>
            {teams.map((t) => (
              <option key={t.teamId} value={t.teamId}>
                {t.displayName} — {t.activeTokens} active token{t.activeTokens === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </FormField>

        {!reissuing && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <FormField id="tk-label" label="Team name" required
                hint="This names the team, not just the token. It can be corrected later without creating a second team.">
                <TextInput id="tk-label" value={label}
                  onChange={(e) => setLabel(e.target.value)} />
              </FormField>
            </div>
            <div style={{ flex: 1 }}>
              <FormField id="tk-email" label="Contact email" required
                hint="How this team is reached when their repository will not clone. They have no account, so there is nothing else.">
                <TextInput id="tk-email" type="email" value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)} />
              </FormField>
            </div>
          </div>
        )}

        {reissuing && (
          <FormField id="tk-reason" label="Why the code is being replaced" required
            hint="Written to the audit trail beside the revocation. The team's previous code stops working the moment this is issued.">
            <TextInput id="tk-reason" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. team lost it; sent to the wrong address" />
          </FormField>
        )}

        <SimilarWarning similar={similar} />

        <p>
          <button type="submit" disabled={busy || !ready}>
            {reissuing ? 'Replace this team\'s code' : 'Create team and issue token'}
          </button>
        </p>
      </form>}

      {tokens.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>
          No tokens issued yet. Until one is, no team can submit.
        </p>
      ) : (
        <table aria-label="Submission tokens">
          <thead>
            <tr>
              <SortableHeader label="Team" sortKey="team" sort={sort} onSort={onSort} />
              <SortableHeader label="Issued" sortKey="issued" sort={sort} onSort={onSort} />
              <SortableHeader label="Last used" sortKey="used" sort={sort} onSort={onSort} />
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.tokenId} style={{ opacity: t.revokedAt ? 0.55 : 1 }}>
                <td>
                  {t.teamName ?? t.label}
                  {onEditTeam && t.teamId !== null && !t.revokedAt && (
                    <TeamEditControl teamId={t.teamId} displayName={t.teamName ?? t.label}
                      contactEmail={teamContact(teams, t.teamId)} busy={busy} onSave={onEditTeam} />
                  )}
                  {t.revokedAt && <span style={{ color: 'var(--danger)' }}> · revoked</span>}
                  {t.teamId === null && !t.revokedAt && (
                    // It will be refused at submission time. Better here than at their deadline.
                    <span style={{ color: 'var(--danger)' }}>
                      {' '}· not bound to a team — reissue it
                    </span>
                  )}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {new Date(t.issuedAt).toLocaleDateString()}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>
                  {/* Never used is worth seeing before a deadline: it usually means the token
                      never reached the team. */}
                  {t.lastUsedAt
                    ? new Date(t.lastUsedAt).toLocaleString()
                    : <span style={{ color: 'var(--warn)' }}>never used</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {onReveal && t.revealable && (
                    <button type="button" disabled={busy} style={{ marginRight: 6 }}
                      onClick={() => onReveal(t.tokenId)}>
                      Reveal
                    </button>
                  )}
                  {onRevoke && !t.revokedAt && (
                    <button type="button" disabled={busy}
                      onClick={() => onRevoke(t.tokenId, t.label)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

const teamContact = (teams: TeamListing[], teamId: number): string =>
  teams.find((t) => t.teamId === teamId)?.contactEmail ?? ''

/**
 * A sortable column header for the token list (E40).
 *
 * Sorting is server-side. Ordering the forty rows in hand would be right today and wrong the
 * moment the list is capped, and "never used first" is a database ordering rather than a
 * client-side reversal of nulls.
 */
function SortableHeader({
  label, sortKey, sort, onSort,
}: {
  label: string
  sortKey: TokenSort
  sort: TokenSort | undefined
  onSort?: (sort: TokenSort) => void
}) {
  if (!onSort) return <th scope="col">{label}</th>

  const active = sort === sortKey
  return (
    <th scope="col" aria-sort={active ? 'other' : 'none'}>
      <button
        type="button" onClick={() => onSort(sortKey)}
        style={{
          border: 'none', background: 'none', font: 'inherit', padding: 0, cursor: 'pointer',
          fontWeight: active ? 700 : 'inherit', color: 'inherit',
        }}
      >
        {label}{active && <span aria-hidden="true"> ▾</span>}
      </button>
    </th>
  )
}
