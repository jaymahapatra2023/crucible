import type { TeamOnBoard } from '../lib/rosterApi.js'
import { TeamEditControl } from './TeamEditControl.js'

/**
 * The team column of the assignment surface (E28-S02).
 *
 * Its own file so `AssignBoard` stays within the component size limit once the create-a-team
 * control was added beside it (P1.4). Nothing about the behaviour changed in the move.
 */
/** The teams, with the selected one's roster expanded. Sticky selection is the point. */
export function TeamList({
  teams, selectedId, busy, onSelect, onUnassign, onSetContact, onEdit,
}: {
  teams: readonly TeamOnBoard[]
  selectedId: number | null
  busy: boolean
  onSelect: (teamId: number) => void
  onUnassign: (participantId: number) => void
  onSetContact: (teamId: number, participantId: number) => void
  /** Correct the team's name or contact in place (E48-S01). */
  onEdit?: (teamId: number, patch: { displayName?: string; contactEmail?: string }) => void
}) {
  if (teams.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        No teams yet. Make one above, issue its token, or give the participant file a{' '}
        <code>team_name</code> column.
      </p>
    )
  }

  return (
    <div>
      <h2 style={{ fontSize: 15, marginTop: 0 }}>Teams</h2>
      <ul aria-label="Teams" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {teams.map((team) => {
          const chosen = team.teamId === selectedId
          return (
            <li key={team.teamId} style={{
              border: `1px solid ${chosen ? 'var(--accent, var(--border))' : 'var(--border)'}`,
              borderRadius: 6, marginBottom: 6, padding: 8,
            }}>
              <button
                type="button" onClick={() => onSelect(team.teamId)}
                aria-pressed={chosen}
                style={{
                  background: 'none', border: 'none', padding: 0, font: 'inherit',
                  cursor: 'pointer', fontWeight: 600, textAlign: 'left',
                }}
              >
                {team.displayName}
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                  {' '}· {team.members.length}
                  {/* Where they sit and who coaches them, because an organiser looking at a team
                      is usually checking one of those. */}
                  {team.roomLabel !== null && ` · ${team.roomLabel}`}
                  {team.coachName !== null && ` · ${team.coachName}`}
                </span>
              </button>
              {chosen && onEdit && (
                <TeamEditControl teamId={team.teamId} displayName={team.displayName}
                  contactEmail={team.contactEmail} busy={busy} onSave={onEdit} />
              )}

              {chosen && team.members.length > 0 && (
                <ul style={{ listStyle: 'none', padding: '6px 0 0', margin: 0, fontSize: 13 }}>
                  {team.members.map((m) => (
                    <li key={m.memberId} style={{
                      display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0',
                    }}>
                      <span>
                        {m.fullName}
                        {m.isContact && (
                          <span style={{ color: 'var(--text-muted)' }}> · point of contact</span>
                        )}
                      </span>
                      <span style={{ display: 'flex', gap: 6 }}>
                        {!m.isContact && (
                          <button type="button" disabled={busy}
                            onClick={() => onSetContact(team.teamId, m.participantId)}>
                            Make contact
                          </button>
                        )}
                        <button type="button" disabled={busy}
                          onClick={() => onUnassign(m.participantId)}>
                          Remove
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
