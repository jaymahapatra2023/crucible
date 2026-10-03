import { useEffect, useMemo, useRef, useState } from 'react'
import type { Participant, RosterBoard } from '../lib/rosterApi.js'
import { TeamList } from './TeamList.js'
import { CreateTeamControl } from './CreateTeamControl.js'

/**
 * Putting 200 people on ~40 teams (E28-S02).
 *
 * The design follows from the volume. At two hundred rows:
 *
 *  - **Keyboard beats mouse.** Type a few letters, press Enter, the person is assigned and the
 *    box clears with focus kept. Drag-and-drop looks friendlier in a screenshot and is slower in
 *    the hand, and a misdrop is silent where a wrong Enter is visible.
 *  - **The unassigned count is the only number that matters.** It is the answer to "are we
 *    done", so it is the largest thing on the screen rather than a line in a table.
 *  - **Undo, with no confirmation.** At this volume a misassignment is certain, and a dialogue on
 *    every action costs more than the mistake it prevents. One keystroke back is cheaper than one
 *    click forward, every time.
 *
 * The selected team is sticky: an operator fills one team, then moves on. Re-picking the team for
 * every person would double the interactions.
 */
export function AssignBoard({
  board, busy, onAssign, onUnassign, onSetContact, onCreateTeam, onUndo, undoable, onEditTeam,
}: {
  board: RosterBoard
  busy: boolean
  onAssign: (teamId: number, participantId: number) => void
  onUnassign: (participantId: number) => void
  onSetContact: (teamId: number, participantId: number) => void
  /** `participantId` is the new team's first member, or null for an empty team. */
  onCreateTeam: (displayName: string, participantId: number | null) => void
  onUndo: () => void
  /** What the last action was, for the undo label. Null when there is nothing to undo. */
  undoable: string | null
  /** Correct a team's name or contact in place (E48-S01). */
  onEditTeam?: (teamId: number, patch: { displayName?: string; contactEmail?: string }) => void
}) {
  const [search, setSearch] = useState('')
  const [teamId, setTeamId] = useState<number | null>(board.teams[0]?.teamId ?? null)
  const searchBox = useRef<HTMLInputElement>(null)
  /** Set while the operator is working through the keyboard path, so focus can be restored. */
  const typing = useRef(false)
  /**
   * A team just created and not yet on the board, to be selected the moment it arrives.
   *
   * Without this the selection stays on whatever team was chosen before, and the operator's next
   * Enter puts somebody on the wrong team — silently, which is the one failure this surface's
   * whole design is meant to avoid.
   */
  const wanted = useRef<string | null>(null)

  /**
   * Put focus back in the search box after an assignment lands.
   *
   * Calling `.focus()` synchronously is not enough: the board refreshes from the server after
   * every assignment, and the re-render that follows leaves the input without focus even though
   * the element itself survives. Restoring it here is what makes "type, Enter, type, Enter"
   * actually work — the whole reason this surface is keyboard-first.
   */
  useEffect(() => {
    if (wanted.current !== null) {
      const fresh = board.teams.find((t) =>
        t.displayName.trim().toLowerCase() === wanted.current!.trim().toLowerCase())
      if (fresh) {
        setTeamId(fresh.teamId)
        wanted.current = null
      }
    }
    if (typing.current) searchBox.current?.focus()
  }, [board])

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return board.unassigned
    return board.unassigned.filter((p) =>
      p.fullName.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle))
  }, [board.unassigned, search])

  const selected = board.teams.find((t) => t.teamId === teamId) ?? null

  function assignFirst() {
    const first = matches[0]
    if (!first || teamId === null) return
    typing.current = true
    onAssign(teamId, first.participantId)
    setSearch('')
    searchBox.current?.focus()
  }

  return (
    <section>
      <header style={{
        display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', marginBottom: 12,
      }}>
        <div>
          {/* The answer to "are we done". Largest thing on the screen, on purpose. */}
          <span data-testid="unassigned-count" style={{ fontSize: 32, fontWeight: 700 }}>
            {board.unassignedTotal}
          </span>
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
            of {board.participantTotal} still to assign
          </span>
        </div>
        {undoable && (
          <button type="button" disabled={busy} onClick={onUndo}>
            Undo — {undoable}
          </button>
        )}
      </header>

      <div className="stack-narrow" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <label htmlFor="assign-search" style={{ fontWeight: 600, display: 'block' }}>
            Find a participant
          </label>
          <p style={{ color: 'var(--text-muted)', margin: '2px 0 6px', fontSize: 12 }}>
            Type a name or an address, then press Enter to put the first match on{' '}
            {selected ? <strong>{selected.displayName}</strong> : 'the selected team'}.
          </p>
          <input
            id="assign-search" ref={searchBox} value={search} autoComplete="off"
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => { typing.current = true }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); assignFirst() } }}
            // NOT disabled while anything is in flight. Disabling the focused element blurs it,
            // which broke the whole fast path: type, Enter, type — the second name went nowhere
            // because the box had lost focus. Assignment is non-blocking for the same reason: a
            // keystroke arriving during a save must be acted on, not dropped.
            disabled={teamId === null}
            style={{
              width: '100%', font: 'inherit', padding: '6px 8px',
              border: '1px solid var(--border)', borderRadius: 6, boxSizing: 'border-box',
            }}
          />

          {board.unassignedTotal > board.unassigned.length && (
            // Never paginated away silently (P5.7): the count above is the real one.
            <p role="status" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              Showing {board.unassigned.length} of {board.unassignedTotal}. Search to reach the rest.
            </p>
          )}

          <ul aria-label="Unassigned participants" style={{ listStyle: 'none', padding: 0 }}>
            {matches.slice(0, 40).map((p, i) => (
              <li key={p.participantId} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '4px 6px', borderBottom: '1px solid var(--border)',
                background: i === 0 && search !== '' ? 'var(--sunk, transparent)' : undefined,
              }}>
                <span>
                  {p.fullName}
                  <span style={{ color: 'var(--text-muted)' }}> · {p.email}</span>
                </span>
                <button type="button" disabled={busy || teamId === null}
                  onClick={() => {
                  typing.current = true
                  onAssign(teamId!, p.participantId)
                  searchBox.current?.focus()
                }}>
                  Assign
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && (
            <p style={{ color: 'var(--text-muted)' }}>
              {board.unassignedTotal === 0
                ? 'Everybody is on a team.'
                : 'Nobody unassigned matches that.'}
            </p>
          )}
        </div>

        <div>
          <CreateTeamControl
            // The person about to be assigned, so creating the team they need takes them with it.
            seed={search.trim() === '' ? null : matches[0] ?? null}
            busy={busy}
            onCreate={(displayName, participantId) => {
              typing.current = true
              wanted.current = displayName
              onCreateTeam(displayName, participantId)
              if (participantId !== null) setSearch('')
            }}
          />
          <TeamList
            teams={board.teams} selectedId={teamId} busy={busy}
            onSelect={(id) => { setTeamId(id); typing.current = true; searchBox.current?.focus() }}
            // Correcting a roster is leaving the fast path: focus belongs where the operator clicked.
            onUnassign={(id) => { typing.current = false; onUnassign(id) }}
            onSetContact={(t, p) => { typing.current = false; onSetContact(t, p) }}
            {...(onEditTeam && { onEdit: onEditTeam })}
          />
        </div>
      </div>
    </section>
  )
}

export type { Participant }
