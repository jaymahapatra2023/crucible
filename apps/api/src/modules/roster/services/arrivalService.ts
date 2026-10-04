/**
 * Coaches confirming they are at the venue (migration 105).
 *
 * Fourteen of the thirty-four coaches take two teams each, so one no-show leaves two teams with
 * nobody. The number an organiser needs at 9am is not "who is missing" but "how many teams have
 * nobody", and nothing in the system could answer it before this.
 *
 * The page lists the coach names, which costs nothing — they are already printed on the door of
 * the room each one is coaching in — and confirming is one tap. No address is asked for: typing
 * one on a phone while walking into a building is the step that would stop people bothering,
 * and a false confirmation redirects no email, reveals no address and changes no team. The
 * timestamp makes a mass confirmation obvious, which is the only abuse worth noticing.
 */
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { listArrivals, markArrived, type CoachArrival } from '../db/arrivalDb.js'

const log = createLogger('roster', 'arrival')

const ACKNOWLEDGED =
  'Thank you — you are marked as here. Your teams and your room are on the sign at the door. '
  + 'If anything looks wrong, find an organiser.'

export interface ArrivalOutcome {
  received: boolean
  message: string
}

export async function confirmArrival(input: {
  fullName: string
}): Promise<ArrivalOutcome> {
  const hit = await markArrived({ fullName: input.fullName.trim() })

  // The id when it matched, never the name or the address: this is a public endpoint and the
  // log is not where personal data accumulates (P8.3).
  log.info('coach arrival claimed', { matched: hit !== null, coachId: hit?.coachId ?? null })

  if (hit !== null) {
    await recordAudit({
      actor: 'public', action: 'roster.coach_arrived', subjectType: 'coach',
      subjectId: String(hit.coachId), payload: {},
    })
  }

  return { received: true, message: ACKNOWLEDGED }
}

export interface ArrivalSummary {
  coaches: CoachArrival[]
  /** The two numbers an organiser acts on. */
  summary: { total: number; arrived: number; missing: number; teamsUncovered: number }
}

export async function arrivalState(): Promise<ArrivalSummary> {
  const coaches = await listArrivals()
  return {
    coaches,
    summary: {
      total: coaches.length,
      arrived: coaches.filter((c) => c.arrived).length,
      missing: coaches.filter((c) => !c.arrived).length,
      // Not the count of missing coaches: a missing coach with two teams leaves two teams.
      teamsUncovered: coaches.reduce((n, c) => n + c.teamsUncovered, 0),
    },
  }
}
