/**
 * Team logistics port (P1.2, P1.3, ADR 0002).
 *
 * Where a team sits and who coaches them. `team_logistics`, `room` and `coach` belong to the
 * **roster** module; the intake dashboard and the team review page belong to submissions and
 * review. Two consumers of one owner's data is what a port is for — the alternative is the same
 * query written out in two modules' `db/` layers, which is two declarations of one fact (P1.5
 * clause 6).
 *
 * **An unregistered implementation is a loud no-op, not a throw** — the opposite of `teamPort`.
 * The distinction is what the data decides. A team's room and coach decide nothing: they tell an
 * organiser where to walk. An intake dashboard that refused to load because nobody had wired the
 * roster would be trading a page that chases failing submissions for a fact about seating.
 */
import { createLogger } from '../logger.js'

const log = createLogger('platform', 'logisticsPort')

export interface TeamPlace {
  teamId: number
  roomLabel: string | null
  coachName: string | null
}

export interface LogisticsPort {
  /** Keyed by team id. A team with no logistics is absent, never a row of nulls. */
  forTeams(teamIds: readonly number[]): Promise<Map<number, TeamPlace>>
}

const unregistered: LogisticsPort = {
  async forTeams() {
    log.warn('no logistics port is registered; rooms and coaches will not be shown')
    return new Map()
  },
}

let impl: LogisticsPort = unregistered

export function registerLogisticsPort(port: LogisticsPort): void {
  impl = port
}

/** Test seam — restores the unregistered implementation. */
export function resetLogisticsPort(): void {
  impl = unregistered
}

export const logistics = (): LogisticsPort => impl
