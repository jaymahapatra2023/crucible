/**
 * Team port (P1.2, P1.3, ADR 0002).
 *
 * The roster assigns people to teams and can create a team from a spreadsheet column. `team` is
 * owned by the **submissions** module, and Appendix C forbids importing another module's service
 * or writing its tables — so roster depends on this interface and submissions registers the
 * implementation at boot.
 *
 * Unlike the audit port, an unregistered implementation **throws**. A dropped audit event must not
 * take down the action it describes; a dropped team assignment has nowhere to go and silently
 * doing nothing would leave an operator looking at a roster that did not save.
 */
import type { DbClient } from '../../db/pool.js'
import { createLogger } from '../logger.js'
import type { DeliveryChannel } from '../../lib/ports/mailPort.js'

const log = createLogger('platform', 'teamPort')

export interface TeamSummary {
  teamId: number
  displayName: string
  contactEmail: string
  /**
   * How the team came to exist (E42-S02). The size rule binds a team the participants formed
   * (`REGISTRATION`); it does not bind one an organiser is holding together on the day.
   */
  origin: 'TOKEN' | 'ORGANISER' | 'BACKFILL' | 'REGISTRATION'
}

export interface TeamPort {
  /** Every team, for the assignment surface and the import's matching. */
  list(): Promise<TeamSummary[]>
  /** By the owning module's own normalisation, so "the same name" means one thing (P1.5). */
  findByName(displayName: string): Promise<TeamSummary | null>
  /**
   * `client` joins the caller's transaction (E44).
   *
   * A registration creates a team, its memberships and its token as ONE act, and two of those
   * three rows belong to the module behind this port. Passing a connection handle through a port
   * is not importing a service (ADR 0002): the handle carries no behaviour, only the guarantee
   * that everything either commits or nothing does. Bulk issue has done the same since E20.
   */
  create(input: {
    displayName: string; contactEmail: string; actor: string; client?: DbClient
    /** The contact's Discord id, resolved at registration (E49). */
    discordUserId?: string | null
  }): Promise<TeamSummary>
  /**
   * Set the team's contact from its point of contact, so E17's value is not typed twice. The
   * Discord id travels with the address (E49); `null` clears it for a contact who has none.
   */
  setContactEmail(input: {
    teamId: number; contactEmail: string; actor: string; discordUserId?: string | null
  }): Promise<void>
  /**
   * Issue the team's submission token inside the caller's transaction (E44-S03).
   *
   * The plaintext is returned to the caller for the one moment it exists — to be emailed after
   * commit — and is stored hashed by the owning module exactly as any other token (P8.3).
   */
  issueToken(input: {
    teamId: number; label: string; actor: string; client?: DbClient
  }): Promise<{ tokenId: number; token: string }>
  /**
   * Record whether the token reached the team (E44-S03, second review).
   *
   * `token_delivery` belongs to submissions. Without this a team that registered itself and
   * whose email failed would be invisible on the delivery panel — the silent gap E34 built that
   * panel to close, reopened by the one path that did not write to it.
   */
  recordTokenDelivery(input: {
    teamId: number; tokenId: number; status: 'SENT' | 'FAILED'
    detail: string | null; providerRef: string | null; templateVersion: number | null
    /** What carried it (E49). Absent means email. */
    channel?: DeliveryChannel
    actor: string
  }): Promise<void>
}

const NOT_REGISTERED =
  'No team port is registered, so teams cannot be read or created. This is a wiring fault at '
  + 'boot, not a problem with the roster.'

const unregistered: TeamPort = {
  async list() { throw fail('list') },
  async findByName() { throw fail('findByName') },
  async create() { throw fail('create') },
  async setContactEmail() { throw fail('setContactEmail') },
  async issueToken() { throw fail('issueToken') },
  async recordTokenDelivery() { throw fail('recordTokenDelivery') },
}

function fail(operation: string): Error {
  log.error('team port not registered', { operation })
  return new Error(NOT_REGISTERED)
}

let impl: TeamPort = unregistered

export function registerTeamPort(port: TeamPort): void {
  impl = port
}

/** Test seam — restores the unregistered implementation. */
export function resetTeamPort(): void {
  impl = unregistered
}

export const teams = (): TeamPort => impl
