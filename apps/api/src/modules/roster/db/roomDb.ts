/**
 * All SQL for rooms (P1.2).
 *
 * Split out of `rosterDb` when a room gained its second, independent limit (migration 101): the
 * number of PEOPLE it holds and the number of TEAMS it holds are different figures and neither
 * follows from the other, so the writers take both and the file was over its line budget (P1.4).
 *
 * A room is taken OUT OF USE rather than deleted. A room used yesterday still has to resolve, or
 * the record of who sat where stops meaning anything (E27-S02).
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'
import type { Room } from '../types/rosterTypes.js'

interface RoomRow {
  room_id: number; label: string; location: string; capacity: number | null
  team_capacity: number | null; in_use: boolean
}

const R_COLS = 'room_id, label, location, capacity, team_capacity, in_use'

const toRoom = (r: RoomRow): Room => ({
  roomId: Number(r.room_id), label: r.label, location: r.location,
  capacity: r.capacity === null ? null : Number(r.capacity),
  teamCapacity: r.team_capacity === null ? null : Number(r.team_capacity),
  inUse: r.in_use,
})

export async function insertRoom(input: {
  label: string; location: string; capacity: number | null
  teamCapacity?: number | null; createdBy: string
}, client?: DbClient): Promise<Room> {
  const row = await queryOne<RoomRow>(
    `INSERT INTO room (label, location, capacity, team_capacity, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${R_COLS}`,
    [input.label, input.location, input.capacity, input.teamCapacity ?? null,
     input.createdBy], client)
  if (!row) throw new Error('insertRoom returned no row')
  return toRoom(row)
}

export async function listRooms(): Promise<Room[]> {
  const res = await query<RoomRow>(
    `SELECT ${R_COLS} FROM room ORDER BY location, lower(label)`)
  return res.rows.map(toRoom)
}

export async function selectRoomByLabel(label: string): Promise<Room | null> {
  const row = await queryOne<RoomRow>(
    `SELECT ${R_COLS} FROM room
      WHERE lower(btrim(label)) = lower(btrim($1))`, [label])
  return row ? toRoom(row) : null
}

export async function updateRoom(input: {
  roomId: number; label?: string; location?: string; capacity?: number | null
  teamCapacity?: number | null; inUse?: boolean
}): Promise<Room | null> {
  const row = await queryOne<RoomRow>(
    `UPDATE room SET label = COALESCE($2, label), location = COALESCE($3, location),
                     in_use = COALESCE($4, in_use),
                     capacity = CASE WHEN $6 THEN $5 ELSE capacity END,
                     team_capacity = CASE WHEN $8 THEN $7 ELSE team_capacity END,
                     updated_at = now()
      WHERE room_id = $1 RETURNING ${R_COLS}`,
    [input.roomId, input.label ?? null, input.location ?? null, input.inUse ?? null,
     input.capacity ?? null, input.capacity !== undefined,
     input.teamCapacity ?? null, input.teamCapacity !== undefined])
  return row ? toRoom(row) : null
}
