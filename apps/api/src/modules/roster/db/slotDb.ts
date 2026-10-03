/**
 * SQL for pre-provisioned team slots (migration 095).
 *
 * The claim is the only interesting statement here, and the reason this file exists separately:
 * it has to be safe when two registrations land in the same millisecond.
 */
import { query, queryOne, type DbClient } from '../../../db/pool.js'

export interface SlotRecord {
  team_id: number
  slot_label: string
  display_name: string
  claimed_at: Date | null
  available: boolean
  room_label: string | null
  coach_name: string | null
  coach_email: string | null
}

const COLS = `team_id, slot_label, display_name, claimed_at, available,
              room_label, coach_name, coach_email`

export async function listSlots(): Promise<SlotRecord[]> {
  const res = await query<SlotRecord>(
    // Natural order, so "Team 2" sorts before "Team 10" the way the printed signs do.
    `SELECT ${COLS} FROM v_roster_team_slot
      ORDER BY length(slot_label), slot_label`)
  return res.rows
}

export async function selectSlotByLabel(label: string): Promise<SlotRecord | null> {
  return queryOne<SlotRecord>(
    `SELECT ${COLS} FROM v_roster_team_slot WHERE lower(slot_label) = lower($1)`, [label])
}

/**
 * Take the next free slot, as the team that just registered.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole point: two registrations confirming at once each take a
 * different slot instead of both reading the same row and one overwriting the other. The claim
 * and the rename are one statement, so a slot cannot be half-claimed.
 *
 * Returns null when the pool is exhausted — which is a fact for the caller to handle, not an
 * error. A registration must never fail because the organisers provisioned fifty slots and
 * fifty-one teams turned up.
 */
export async function claimNextSlot(
  input: { displayName: string; contactEmail: string; contactDiscordUserId?: string | null },
  client?: DbClient,
): Promise<{ teamId: number; slotLabel: string } | null> {
  const row = await queryOne<{ team_id: number; slot_label: string }>(
    `UPDATE team SET
       display_name = $1,
       contact_email = $2,
       contact_discord_user_id = $3,
       claimed_at = now(),
       updated_at = now()
     WHERE team_id = (
       SELECT team_id FROM team
        WHERE slot_label IS NOT NULL AND claimed_at IS NULL
        ORDER BY length(slot_label), slot_label
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING team_id, slot_label`,
    [input.displayName, input.contactEmail, input.contactDiscordUserId ?? null], client)
  return row ? { teamId: Number(row.team_id), slotLabel: row.slot_label } : null
}
