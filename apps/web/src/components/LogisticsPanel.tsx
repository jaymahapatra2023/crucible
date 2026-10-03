import type { Coach, Room, TeamLogistics, TeamOnBoard } from '../lib/rosterApi.js'

/**
 * Where each team sits and who coaches them (E27-S03, surfaced in E31).
 *
 * One row per team with two selects. The whole surface is a table rather than a form per team
 * because the question an organiser actually has is comparative — *which teams still have no
 * room* — and that is answered by reading a column, not by opening forty pages.
 *
 * **A room already given to another team is shown as taken, in the list, rather than being hidden
 * from it.** The database refuses the second allocation naming the team that has it; an option
 * quietly missing would leave the operator hunting for a room that appears not to exist.
 *
 * Rooms out of use and inactive coaches are not offered — but one already allocated is still
 * shown on its team, because taking a room out of use does not unseat whoever is in it, and
 * hiding the fact would make the record disagree with the building.
 */
export function LogisticsPanel({
  teams, logistics, rooms, coaches, busy, onAssign,
}: {
  teams: readonly TeamOnBoard[]
  logistics: readonly TeamLogistics[]
  rooms: readonly Room[]
  coaches: readonly Coach[]
  busy: boolean
  onAssign: (teamId: number, changes: { roomId?: number | null; coachId?: number | null }) => void
}) {
  if (teams.length === 0) {
    return <p style={{ color: 'var(--text-muted)' }}>No teams yet, so there is nothing to place.</p>
  }

  const byTeam = new Map(logistics.map((l) => [l.teamId, l]))
  /** Which team holds each room, so an allocated one can say so instead of disappearing. */
  const holder = new Map<number, string>()
  for (const l of logistics) {
    if (l.roomId === null) continue
    const team = teams.find((t) => t.teamId === l.teamId)
    if (team) holder.set(l.roomId, team.displayName)
  }

  const unplaced = teams.filter((t) => (byTeam.get(t.teamId)?.roomId ?? null) === null).length
  const uncoached = teams.filter((t) => (byTeam.get(t.teamId)?.coachId ?? null) === null).length

  return (
    <section>
      <h2 style={{ fontSize: 15 }}>Rooms and coaches, by team</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 8px' }}>
        {unplaced === 0 && uncoached === 0
          ? `All ${teams.length} teams have a room and a coach.`
          : `${unplaced} of ${teams.length} without a room, ${uncoached} without a coach.`}
      </p>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <caption className="sr-only">Each team&apos;s room and coach</caption>
        <thead>
          <tr>
            <th scope="col" style={HEAD}>Team</th>
            <th scope="col" style={HEAD}>Room</th>
            <th scope="col" style={HEAD}>Coach</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((team) => {
            const place = byTeam.get(team.teamId)
            return (
              <tr key={team.teamId}>
                <td style={CELL}>
                  {team.displayName}
                  <span style={{ color: 'var(--text-muted)' }}> · {team.members.length}</span>
                </td>
                <td style={CELL}>
                  <select
                    aria-label={`Room for ${team.displayName}`} disabled={busy}
                    value={place?.roomId ?? ''}
                    onChange={(e) => onAssign(team.teamId, {
                      roomId: e.target.value === '' ? null : Number(e.target.value),
                    })}
                    style={CONTROL}
                  >
                    <option value="">No room</option>
                    {rooms
                      .filter((r) => r.inUse || r.roomId === place?.roomId)
                      .map((r) => {
                        const taken = holder.get(r.roomId)
                        const mine = r.roomId === place?.roomId
                        return (
                          <option key={r.roomId} value={r.roomId}>
                            {r.label}
                            {r.location !== '' && ` — ${r.location}`}
                            {taken !== undefined && !mine && ` (with ${taken})`}
                          </option>
                        )
                      })}
                  </select>
                </td>
                <td style={CELL}>
                  <select
                    aria-label={`Coach for ${team.displayName}`} disabled={busy}
                    value={place?.coachId ?? ''}
                    onChange={(e) => onAssign(team.teamId, {
                      coachId: e.target.value === '' ? null : Number(e.target.value),
                    })}
                    style={CONTROL}
                  >
                    <option value="">No coach</option>
                    {/* A coach may take more than one team, so nothing here is exclusive. */}
                    {coaches
                      .filter((c) => c.active || c.coachId === place?.coachId)
                      .map((c) => (
                        <option key={c.coachId} value={c.coachId}>{c.fullName}</option>
                      ))}
                  </select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

const HEAD: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px', borderBottom: '2px solid var(--border)',
  fontSize: 12, color: 'var(--text-muted)',
}
const CELL: React.CSSProperties = {
  padding: '4px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle',
}
const CONTROL: React.CSSProperties = {
  font: 'inherit', padding: '3px 6px', border: '1px solid var(--border)',
  borderRadius: 6, background: 'var(--surface)', color: 'var(--text)', maxWidth: '100%',
}
