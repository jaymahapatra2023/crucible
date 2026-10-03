/**
 * Pre-provisioned team slots (migration 095).
 *
 * The floor plan before anyone arrives: "Team 7 — Ada Room — coach Margaret", printed and taped
 * to a door. A registering team then claims the next free slot and inherits its room and coach,
 * so nobody is matching teams to rooms while fifty students wait.
 *
 * A slot IS a team row, claimed rather than copied. The submission token is the team's identity
 * (E17-S01); two rows and a transfer would mean two identities for one team halfway through an
 * event.
 *
 * Checked before it is written, like every other bulk path here: the plan says what each row
 * would do, and a file with any unusable row is refused whole. Provisioning is idempotent on the
 * slot label, so a second file adding slots 51 to 60 leaves 1 to 50 alone.
 *
 * Several slots may share a room (migration 096). The plan reports how many land in each, with
 * the room's capacity beside it, because a hall holding four teams is the intended arrangement
 * and a hall holding fourteen is probably a typo. It reports; it does not refuse.
 */
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { headerIndex, parseCsv } from '../../../lib/csv.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { createTeam } from '../../submissions/services/teamService.js'
import {
  listCoaches, upsertLogistics,
} from '../db/rosterDb.js'
import { listRooms } from '../db/roomDb.js'
import { listSlots, selectSlotByLabel } from '../db/slotDb.js'

const log = createLogger('roster', 'slots')

const MAX_ROWS = 500

export const SLOT_OUTCOMES = ['NEW', 'EXISTING', 'INVALID'] as const
export type SlotOutcome = (typeof SLOT_OUTCOMES)[number]

export interface SlotRow {
  line: number
  label: string
  roomLabel: string
  coachName: string
  outcome: SlotOutcome
  /** Why a row cannot be acted on, in words an organiser can fix the file from. */
  detail: string | null
  teamId: number | null
}

export interface SlotPlan {
  rows: SlotRow[]
  summary: { total: number; new: number; existing: number; invalid: number }
  /**
   * How many slots this file puts in each room, against BOTH of the room's limits (migration
   * 101). Advisory: it reports, it does not refuse.
   *
   * `teamCapacity` is the one that matters when reading this list — a room that seats 100 people
   * but takes 12 teams is over-filled at the thirteenth slot, and the people figure would have
   * said nothing was wrong.
   */
  roomLoad: Array<{
    room: string
    slots: number
    capacity: number | null
    teamCapacity: number | null
    /** True when this file puts more slots in the room than it holds teams. */
    overTeamCapacity: boolean
  }>
  /**
   * How many slots this file gives each coach, against the number they agreed to take
   * (migration 102). Advisory, for the same reason as the room list.
   *
   * Worth looking at before provisioning: 34 coaches who between them agreed to 48 teams cannot
   * cover 52 slots, and the coach who finds out on the day is the wrong person to discover it.
   */
  coachLoad: Array<{
    coach: string
    slots: number
    teamCapacity: number | null
    overTeamCapacity: boolean
  }>
  provisioned: boolean
  refusal: string | null
}

const COLUMNS = {
  label: ['label', 'slot', 'team', 'team_name', 'slot_label'],
  room: ['room', 'room_label', 'table', 'location'],
  coach: ['coach', 'coach_name', 'mentor'],
} as const

/** What the file would do, without doing it. */
export async function planSlots(csv: string): Promise<SlotRow[]> {
  const parsed = parseCsv(csv)
  if (parsed.length === 0) throw new AppError('VALIDATION_FAILED', 'That file has no rows.')
  const header = parsed[0]!.cells
  const idx = headerIndex(header, COLUMNS)
  const body = parsed.slice(1).filter((r) => r.cells.some((c) => c.trim() !== ''))

  if (body.length > MAX_ROWS) {
    throw new AppError('VALIDATION_FAILED',
      `That file has ${body.length} rows; ${MAX_ROWS} is the most this will take at once.`)
  }

  const [rooms, coaches, slots] = await Promise.all([
    listRooms(), listCoaches(), listSlots(),
  ])
  const roomByLabel = new Map(rooms.map((r) => [r.label.trim().toLowerCase(), r]))
  const coachByName = new Map(coaches.map((c) => [c.fullName.trim().toLowerCase(), c]))
  const coachByEmail = new Map(coaches.map((c) => [c.email.trim().toLowerCase(), c]))
  const slotByLabel = new Map(slots.map((s) => [s.slot_label.trim().toLowerCase(), s]))

  const seenLabels = new Set<string>()
  const rows: SlotRow[] = []
  const lookups = { slotByLabel, roomByLabel, coachByName, coachByEmail }

  for (const record of body) {
    rows.push(planOne(record, idx, seenLabels, lookups))
  }

  return rows
}

export async function provisionSlots(input: {
  csv: string
  confirm: boolean
  actor: string
}): Promise<SlotPlan> {
  const rows = await planSlots(input.csv)
  const invalid = rows.filter((r) => r.outcome === 'INVALID')

  const limits: Limits = {
    rooms: new Map((await listRooms()).map((r) =>
      [r.label.trim().toLowerCase(), { people: r.capacity, teams: r.teamCapacity }])),
    coaches: new Map((await listCoaches()).map((c) =>
      [c.fullName.trim().toLowerCase(), c.teamCapacity])),
  }

  if (!input.confirm) return summarise(rows, false, null, limits)

  if (invalid.length > 0) {
    return summarise(rows, false,
      `Nothing was provisioned. ${invalid.length} of ${rows.length} rows cannot be acted on — `
      + 'fix them and upload the file again.', limits)
  }

  const [rooms, coaches] = await Promise.all([listRooms(), listCoaches()])
  const roomByLabel = new Map(rooms.map((r) => [r.label.trim().toLowerCase(), r]))
  const coachByName = new Map(coaches.map((c) => [c.fullName.trim().toLowerCase(), c]))
  const coachByEmail = new Map(coaches.map((c) => [c.email.trim().toLowerCase(), c]))

  let created = 0
  for (const row of rows) {
    if (row.outcome !== 'NEW') continue
    // A slot carries no contact address: nobody owns it until a registration claims it, and a
    // placeholder address would be a real address that receives nothing.
    const team = await createTeam({
      displayName: row.label,
      contactEmail: '',
      origin: 'ORGANISER',
      actor: input.actor,
      slotLabel: row.label,
    })
    row.teamId = team.teamId

    const room = roomByLabel.get(row.roomLabel.toLowerCase())
    const coach = coachByName.get(row.coachName.toLowerCase())
      ?? coachByEmail.get(row.coachName.toLowerCase())
    if (room || coach) {
      await upsertLogistics({
        teamId: team.teamId,
        ...(room && { roomId: room.roomId }),
        ...(coach && { coachId: coach.coachId }),
        actor: input.actor,
      })
    }
    created += 1
  }

  await recordAudit({
    actor: input.actor, action: 'roster.slots_provisioned', subjectType: 'roster', subjectId: 'slots',
    payload: { created, existing: rows.filter((r) => r.outcome === 'EXISTING').length },
  })
  log.info('team slots provisioned', { created, total: rows.length })

  return summarise(rows, true, null, limits)
}

/** Where the pool stands, for the readiness surface and for the organiser on the day. */
export async function slotStatus(): Promise<{
  total: number; available: number; claimed: number
  withoutRoom: number; withoutCoach: number
}> {
  const slots = await listSlots()
  return {
    total: slots.length,
    available: slots.filter((s) => s.claimed_at === null).length,
    claimed: slots.filter((s) => s.claimed_at !== null).length,
    withoutRoom: slots.filter((s) => s.room_label === null).length,
    withoutCoach: slots.filter((s) => s.coach_name === null).length,
  }
}

export async function slotByLabel(label: string): Promise<SlotRow | null> {
  const row = await selectSlotByLabel(label)
  if (!row) return null
  return {
    line: 0, label: row.slot_label, roomLabel: row.room_label ?? '',
    coachName: row.coach_name ?? '', outcome: 'EXISTING',
    detail: row.claimed_at === null ? 'Free.' : `Claimed by "${row.display_name}".`,
    teamId: Number(row.team_id),
  }
}

interface Lookups {
  slotByLabel: Map<string, { team_id: number; claimed_at: Date | null; display_name: string }>
  roomByLabel: Map<string, { roomId: number; label: string }>
  coachByName: Map<string, { coachId: number }>
  coachByEmail: Map<string, { coachId: number }>
}

/** One row, judged against what already exists and against the rows above it. */
function planOne(
  record: { line: number; cells: string[] },
  idx: Record<string, number>,
  seenLabels: Set<string>,
  lookups: Lookups,
): SlotRow {
  const label = (record.cells[idx['label']!] ?? '').trim()
  const roomLabel = (record.cells[idx['room']!] ?? '').trim()
  const coachName = (record.cells[idx['coach']!] ?? '').trim()
  const base = { line: record.line, label, roomLabel, coachName, teamId: null }
  const invalid = (detail: string): SlotRow => ({ ...base, outcome: 'INVALID', detail })

  if (label === '') return invalid('No slot label.')
  if (seenLabels.has(label.toLowerCase())) {
    return invalid(`"${label}" appears more than once in this file.`)
  }
  seenLabels.add(label.toLowerCase())

  const existing = lookups.slotByLabel.get(label.toLowerCase())
  if (existing) {
    return {
      ...base, outcome: 'EXISTING', teamId: Number(existing.team_id),
      detail: existing.claimed_at === null
        ? 'Already provisioned and still free; left alone.'
        : `Already provisioned and claimed by "${existing.display_name}"; left alone.`,
    }
  }

  if (roomLabel !== '' && !lookups.roomByLabel.has(roomLabel.toLowerCase())) {
    return invalid(`No room called "${roomLabel}". Upload the rooms first.`)
  }
  if (coachName !== ''
      && !lookups.coachByName.has(coachName.toLowerCase())
      && !lookups.coachByEmail.has(coachName.toLowerCase())) {
    return invalid(`No coach called "${coachName}". Upload the coaches first.`)
  }

  return { ...base, outcome: 'NEW', detail: null }
}

interface RoomLimits { people: number | null; teams: number | null }

/** The two limit tables, passed as one so `summarise` keeps a readable signature. */
interface Limits {
  rooms: Map<string, RoomLimits>
  coaches: Map<string, number | null>
}

const NO_LIMITS: Limits = { rooms: new Map(), coaches: new Map() }

function summarise(
  rows: SlotRow[], provisioned: boolean, refusal: string | null, limits: Limits = NO_LIMITS,
): SlotPlan {
  const counts = new Map<string, number>()
  const coachCounts = new Map<string, number>()
  for (const row of rows) {
    if (row.outcome === 'INVALID') continue
    if (row.roomLabel !== '') counts.set(row.roomLabel, (counts.get(row.roomLabel) ?? 0) + 1)
    if (row.coachName !== '') {
      coachCounts.set(row.coachName, (coachCounts.get(row.coachName) ?? 0) + 1)
    }
  }
  return {
    rows,
    coachLoad: [...coachCounts.entries()]
      .map(([coach, slots]) => {
        const teamCapacity = limits.coaches.get(coach.toLowerCase()) ?? null
        return {
          coach, slots, teamCapacity,
          overTeamCapacity: teamCapacity !== null && slots > teamCapacity,
        }
      })
      // Over-booked coaches first: the only rows anyone needs to act on.
      .sort((a, b) => Number(b.overTeamCapacity) - Number(a.overTeamCapacity) || b.slots - a.slots),
    roomLoad: [...counts.entries()]
      .map(([room, slots]) => {
        const room_ = limits.rooms.get(room.toLowerCase())
        const teamCapacity = room_?.teams ?? null
        return {
          room, slots,
          capacity: room_?.people ?? null,
          teamCapacity,
          overTeamCapacity: teamCapacity !== null && slots > teamCapacity,
        }
      })
      // Over-filled rooms first: they are the only rows anyone needs to act on.
      .sort((a, b) => Number(b.overTeamCapacity) - Number(a.overTeamCapacity) || b.slots - a.slots),
    summary: {
      total: rows.length,
      new: rows.filter((r) => r.outcome === 'NEW').length,
      existing: rows.filter((r) => r.outcome === 'EXISTING').length,
      invalid: rows.filter((r) => r.outcome === 'INVALID').length,
    },
    provisioned,
    refusal,
  }
}
