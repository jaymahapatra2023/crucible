/**
 * Roster types (E27).
 *
 * Participants, rooms and coaches: the three lists loaded before an event. None of them is a
 * Crucible user, and a coach is deliberately not a participant.
 */

export const DELETE_REASONS = [
  'USER_REQUEST', 'ADMIN_ACTION', 'GDPR_ERASURE', 'CASCADE', 'DEDUP', 'SUPERSEDED',
] as const
export type DeleteReason = (typeof DELETE_REASONS)[number]

export interface Participant {
  participantId: number
  fullName: string
  email: string
  organisation: string | null
  phone: string | null
  notes: string
  /** As given (E49). Resolved against the event server when a bot is configured. */
  discordUsername: string | null
  /** The resolved id — what a DM needs. Null until resolved. Personal data: never logged. */
  discordUserId: string | null
}

export interface Room {
  roomId: number
  label: string
  /** The floor, for a venue spread over several. Free text; the plan says "Greene 4". */
  location: string
  /** How many PEOPLE it holds. */
  capacity: number | null
  /**
   * How many TEAMS it holds (migration 101).
   *
   * Independent of `capacity`, not derived from it: the Dining Room seats 100 and takes 12
   * teams, room 418 seats 8 and takes 1. Both are advisory.
   */
  teamCapacity: number | null
  /** Taken out of use rather than deleted — a room used yesterday still has to resolve. */
  inUse: boolean
}

export interface Coach {
  coachId: number
  fullName: string
  email: string
  organisation: string | null
  /**
   * How many teams this coach agreed to take (migration 102).
   *
   * Null means nobody asked, which is different from one. Advisory: a coach picking up a third
   * team because somebody went home is the right call, not an error.
   */
  teamCapacity: number | null
  active: boolean
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
