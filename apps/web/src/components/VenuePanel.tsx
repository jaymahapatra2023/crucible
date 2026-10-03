import { useState } from 'react'
import { TextInput } from './FormField.js'
import type { Coach, Room } from '../lib/rosterApi.js'

/**
 * Rooms and coaches, added and corrected by hand (E31-S02).
 *
 * Both are loaded from a file before the day; this is the late change — a room that turned out to
 * be double-booked, a coach who stepped in that morning.
 *
 * A room is taken **out of use** rather than deleted, and a coach is made **inactive** rather than
 * deleted, because a room that was used yesterday still needs to exist for the record of who sat
 * where to mean anything (E27-S02 acceptance 2).
 */
export function VenuePanel({
  rooms, coaches, busy, onAddRoom, onSaveRoom, onAddCoach, onSaveCoach,
}: {
  rooms: readonly Room[]
  coaches: readonly Coach[]
  busy: boolean
  onAddRoom: (input: {
    label: string; location: string; capacity: number | null; teamCapacity: number | null
  }) => void
  onSaveRoom: (roomId: number, changes: Partial<Room>) => void
  onAddCoach: (input: {
    fullName: string; email: string; organisation: string | null; teamCapacity: number | null
  }) => void
  onSaveCoach: (coachId: number, changes: Partial<Coach>) => void
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      <RoomList rooms={rooms} busy={busy} onAdd={onAddRoom} onSave={onSaveRoom} />
      <CoachList coaches={coaches} busy={busy} onAdd={onAddCoach} onSave={onSaveCoach} />
    </div>
  )
}

function RoomList({
  rooms, busy, onAdd, onSave,
}: {
  rooms: readonly Room[]
  busy: boolean
  onAdd: (input: {
    label: string; location: string; capacity: number | null; teamCapacity: number | null
  }) => void
  onSave: (roomId: number, changes: Partial<Room>) => void
}) {
  const [label, setLabel] = useState('')
  const [location, setLocation] = useState('')
  const [capacity, setCapacity] = useState('')
  const [teamCapacity, setTeamCapacity] = useState('')

  return (
    <section>
      <h2 style={{ fontSize: 15 }}>Rooms</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (label.trim() === '') return
          onAdd({
            label: label.trim(), location: location.trim(),
            capacity: capacity.trim() === '' ? null : Number(capacity),
            teamCapacity: teamCapacity.trim() === '' ? null : Number(teamCapacity),
          })
          setLabel(''); setLocation(''); setCapacity(''); setTeamCapacity('')
        }}
        style={FORM}
      >
        <TextInput aria-label="Room label" placeholder="Label" value={label}
          style={{ width: 120 }} onChange={(e) => setLabel(e.target.value)} />
        <TextInput aria-label="Room location" placeholder="Floor or building" value={location}
          style={{ width: 140 }} onChange={(e) => setLocation(e.target.value)} />
        <TextInput aria-label="Room capacity" type="number" min={1} placeholder="Seats"
          value={capacity} style={{ width: 80 }}
          onChange={(e) => setCapacity(e.target.value)} />
        {/* The second, independent limit (migration 101). Two boxes rather than one, because
            the venue plan gives two numbers and neither follows from the other. */}
        <TextInput aria-label="Room team capacity" type="number" min={1} placeholder="Teams"
          value={teamCapacity} style={{ width: 80 }}
          onChange={(e) => setTeamCapacity(e.target.value)} />
        <button type="submit" disabled={busy || label.trim() === ''}>Add room</button>
      </form>

      {rooms.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No rooms yet.</p>
      ) : (
        <ul aria-label="Rooms" style={LIST}>
          {rooms.map((room) => (
            <li key={room.roomId} style={ITEM}>
              <span>
                <strong>{room.label}</strong>
                <span style={{ color: 'var(--text-muted)' }}>
                  {room.location !== '' && ` · ${room.location}`}
                  {room.capacity !== null && ` · ${room.capacity} seats`}
                  {room.teamCapacity !== null && ` · ${room.teamCapacity} ${room.teamCapacity === 1 ? 'team' : 'teams'}`}
                </span>
              </span>
              {/* Not colour alone (P5.4): the state is written out beside the control. */}
              <label style={TOGGLE}>
                <input
                  type="checkbox" checked={room.inUse} disabled={busy}
                  // Named for the room, not for the state: a control whose name changes when you
                  // use it cannot be found again by the person who just used it.
                  aria-label={`${room.label} in use`}
                  onChange={(e) => onSave(room.roomId, { inUse: e.target.checked })}
                />
                {room.inUse ? 'In use' : 'Out of use'}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CoachList({
  coaches, busy, onAdd, onSave,
}: {
  coaches: readonly Coach[]
  busy: boolean
  onAdd: (input: {
    fullName: string; email: string; organisation: string | null; teamCapacity: number | null
  }) => void
  onSave: (coachId: number, changes: Partial<Coach>) => void
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [teams, setTeams] = useState('')

  const ready = fullName.trim().length >= 2 && /.+@.+\..+/.test(email.trim())

  return (
    <section>
      <h2 style={{ fontSize: 15 }}>Coaches</h2>
      {/* Stated once, where it matters: a coach is not on a team and never becomes one. */}
      <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 6px' }}>
        A coach is not a participant and is never a member of a team.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!ready) return
          onAdd({
            fullName: fullName.trim(), email: email.trim(), organisation: null,
            teamCapacity: teams.trim() === '' ? null : Number(teams),
          })
          setFullName(''); setEmail(''); setTeams('')
        }}
        style={FORM}
      >
        <TextInput aria-label="Coach name" placeholder="Full name" value={fullName}
          style={{ width: 150 }} onChange={(e) => setFullName(e.target.value)} />
        <TextInput aria-label="Coach email" type="email" placeholder="Email" value={email}
          style={{ width: 190 }} onChange={(e) => setEmail(e.target.value)} />
        {/* How many teams they agreed to take (migration 102). Optional: null means nobody
            asked, which is a different fact from one. */}
        <TextInput aria-label="Coach team capacity" type="number" min={1} placeholder="Teams"
          value={teams} style={{ width: 80 }} onChange={(e) => setTeams(e.target.value)} />
        <button type="submit" disabled={busy || !ready}>Add coach</button>
      </form>

      {coaches.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No coaches yet.</p>
      ) : (
        <ul aria-label="Coaches" style={LIST}>
          {coaches.map((coach) => (
            <li key={coach.coachId} style={ITEM}>
              <span>
                <strong>{coach.fullName}</strong>
                <span style={{ color: 'var(--text-muted)' }}>
                  {' · '}{coach.email}
                  {coach.teamCapacity !== null
                    && ` · ${coach.teamCapacity} ${coach.teamCapacity === 1 ? 'team' : 'teams'}`}
                </span>
              </span>
              <label style={TOGGLE}>
                <input
                  type="checkbox" checked={coach.active} disabled={busy}
                  aria-label={`${coach.fullName} active`}
                  onChange={(e) => onSave(coach.coachId, { active: e.target.checked })}
                />
                {coach.active ? 'Active' : 'Inactive'}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const FORM: React.CSSProperties = {
  display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
  border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10,
}
const LIST: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }
const ITEM: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
  padding: '4px 6px', borderBottom: '1px solid var(--border)',
}
const TOGGLE: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, whiteSpace: 'nowrap',
}
