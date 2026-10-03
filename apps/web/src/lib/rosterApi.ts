/** The roster: participants, rooms, coaches, and who is on which team (E27, E28). */
import { del, get, patchJson, post, put } from './apiClient.js'

export interface Participant {
  participantId: number
  fullName: string
  email: string
  organisation: string | null
  phone: string | null
  notes: string
  /** As given (E49); resolved against the event server when a bot is configured. */
  discordUsername: string | null
  /** Resolved id — null means the username could not be found, or Discord is not configured. */
  discordUserId: string | null
}

export interface TeamMember {
  memberId: number
  teamId: number
  participantId: number
  fullName: string
  email: string
  organisation: string | null
  /** The person the team is reached through; their address becomes the team's contact. */
  isContact: boolean
}

export interface TeamOnBoard {
  teamId: number
  displayName: string
  contactEmail: string
  members: TeamMember[]
  roomLabel: string | null
  coachName: string | null
}

export interface RosterBoard {
  unassigned: Participant[]
  /** The real total, which may exceed the list above. This is the number that says whether it is done. */
  unassignedTotal: number
  participantTotal: number
  teams: TeamOnBoard[]
}

export interface Room {
  roomId: number
  label: string
  /** The floor, for a venue spread over several. */
  location: string
  /** How many PEOPLE it holds. */
  capacity: number | null
  /** How many TEAMS it holds, independent of the people figure (migration 101). */
  teamCapacity: number | null
  inUse: boolean
}

export interface Coach {
  coachId: number
  fullName: string
  email: string
  organisation: string | null
  active: boolean
  /** How many teams they agreed to take (migration 102). */
  teamCapacity: number | null
}

export const ROSTER_KINDS = ['participant', 'room', 'coach'] as const
export type RosterKind = (typeof ROSTER_KINDS)[number]

export const IMPORT_OUTCOMES = ['NEW', 'EXISTING', 'INVALID', 'DUPLICATE'] as const
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number]

export interface ImportRow {
  line: number
  label: string
  detail: string | null
  outcome: ImportOutcome
  id: number | null
  /** The team this row would join, where it named one. */
  teamName: string | null
  teamIsNew: boolean
}

export interface ImportPlan {
  kind: RosterKind
  rows: ImportRow[]
  summary: { total: number; new: number; existing: number; invalid: number; duplicate: number }
  imported: boolean
  refusal: string | null
}

export interface RosterCheck {
  id: string
  statement: string
  status: 'PASS' | 'FAIL' | 'UNKNOWN'
  detail: string
}

export const getBoard = () => get<RosterBoard>('/roster/board')
export const getRooms = () => get<Room[]>('/roster/rooms')
export const getCoaches = () => get<Coach[]>('/roster/coaches')
export const getRosterReadiness = () => get<RosterCheck[]>('/roster/readiness')

/** Ask what a file would do (`confirm: false`), or do it. */
export const importRoster = (kind: RosterKind, csv: string, confirm: boolean) =>
  post<ImportPlan>('/roster/import', { kind, csv, confirm })

/**
 * Put a participant on a team, taking them off whatever team they are on first.
 *
 * `move` rather than a refusal: on the assignment screen, clicking a second team is almost always
 * a correction, and making the operator unassign first would double the work of every mistake.
 */
export const assignMember = (teamId: number, participantId: number) =>
  put<TeamMember>(`/roster/teams/${teamId}/members`, { participantId, move: true })

/**
 * Create a team, optionally with its first member — who becomes its point of contact.
 *
 * Refused with a named clash when the name matches an existing team ignoring case, punctuation and
 * a leading "the", rather than quietly assigning to that team under a name nobody typed.
 */
export const createTeam = (displayName: string, participantId: number | null) =>
  post<{ team: { teamId: number; displayName: string; contactEmail: string }; contact: TeamMember | null }>(
    '/roster/teams',
    participantId === null ? { displayName } : { displayName, participantId },
  )

export const unassignMember = (participantId: number) =>
  del(`/roster/members/${participantId}`)

export const setTeamContact = (teamId: number, participantId: number) =>
  put<TeamMember>(`/roster/teams/${teamId}/contact`, { participantId })

/** Add one record by hand. Refused with a named clash when it is already on the roster. */
export const createParticipant = (input: {
  fullName: string; email: string; organisation?: string | null; phone?: string | null
  discordUsername?: string | null
}) => post<Participant>('/roster/participants', input)

export const createRoom = (input: {
  label: string; location?: string; capacity?: number | null; teamCapacity?: number | null
}) => post<Room>('/roster/rooms', input)

export const createCoach = (input: {
  fullName: string; email: string; organisation?: string | null; teamCapacity?: number | null
}) => post<Coach>('/roster/coaches', input)

export const removeParticipant = (participantId: number, reason: string) =>
  del(`/roster/participants/${participantId}?reason=${encodeURIComponent(reason)}`)

export const PARTICIPANT_SORTS = ['name', 'email', 'organisation', 'added'] as const
export type ParticipantSort = (typeof PARTICIPANT_SORTS)[number]

export interface PeopleQuery {
  search?: string
  sort?: ParticipantSort
  page?: number
}

export const getParticipants = (q: PeopleQuery = {}) => {
  const params = new URLSearchParams()
  if (q.search !== undefined && q.search.trim() !== '') params.set('search', q.search.trim())
  if (q.sort !== undefined) params.set('sort', q.sort)
  params.set('page', String(q.page ?? 1))
  params.set('pageSize', '25')
  return get<{ participants: Participant[]; total: number }>(
    `/roster/participants?${params.toString()}`)
}

/** What one team was given. Absent values are real: a team exists before its logistics do. */
export interface TeamLogistics {
  teamId: number
  roomId: number | null
  roomLabel: string | null
  roomLocation: string | null
  coachId: number | null
  coachName: string | null
  coachEmail: string | null
}

export const getLogistics = () => get<TeamLogistics[]>('/roster/logistics')

export const updateParticipant = (participantId: number, changes: Partial<{
  fullName: string; email: string; organisation: string | null; phone: string | null
  discordUsername: string | null
}>) => patchJson<Participant>(`/roster/participants/${participantId}`, changes)

export const updateRoom = (roomId: number, changes: Partial<{
  label: string; location: string; capacity: number | null; teamCapacity: number | null
  inUse: boolean
}>) => patchJson<Room>(`/roster/rooms/${roomId}`, changes)

export const updateCoach = (coachId: number, changes: Partial<{
  fullName: string; email: string; organisation: string | null
  teamCapacity: number | null; active: boolean
}>) => patchJson<Coach>(`/roster/coaches/${coachId}`, changes)

export const assignLogistics = (
  teamId: number, changes: { roomId?: number | null; coachId?: number | null },
) => put<unknown>(`/roster/teams/${teamId}/logistics`, changes)

// ── Pre-provisioned team slots (migration 095) ───────────────────────────────────────────────

export interface TeamSlot {
  team_id: number
  slot_label: string
  display_name: string
  claimed_at: string | null
  available: boolean
  room_label: string | null
  coach_name: string | null
  coach_email: string | null
}

export interface SlotStatus {
  total: number
  available: number
  claimed: number
  withoutRoom: number
  withoutCoach: number
}

export interface SlotPlanRow {
  line: number
  label: string
  roomLabel: string
  coachName: string
  outcome: 'NEW' | 'EXISTING' | 'INVALID'
  detail: string | null
  teamId: number | null
}

export interface SlotPlan {
  rows: SlotPlanRow[]
  summary: { total: number; new: number; existing: number; invalid: number }
  roomLoad: Array<{
    room: string; slots: number; capacity: number | null
    teamCapacity: number | null; overTeamCapacity: boolean
  }>
  coachLoad: Array<{
    coach: string; slots: number
    teamCapacity: number | null; overTeamCapacity: boolean
  }>
  provisioned: boolean
  refusal: string | null
}

export const getSlots = () => get<{ status: SlotStatus; slots: TeamSlot[] }>('/roster/slots')
export const planSlots = (csv: string) => post<SlotPlan>('/roster/slots', { csv, confirm: false })
export const provisionSlots = (csv: string) => post<SlotPlan>('/roster/slots', { csv, confirm: true })
