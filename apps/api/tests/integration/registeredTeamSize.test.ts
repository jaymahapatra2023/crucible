/**
 * The size rule binds a team the participants formed, and only that team (E42-S02 acceptance 3, 4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { resetTeamPort, teams } from '../../src/lib/ports/teamPort.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { assign, unassign } from '../../src/modules/roster/services/membershipService.js'
import { listParticipants } from '../../src/modules/roster/db/rosterDb.js'
import { rosterReadiness } from '../../src/modules/roster/services/rosterReadiness.js'
import { tx } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'size' }, fn)

const CSV = 'full_name,email\nAda Lovelace,ada@example.test\nGrace Hopper,grace@example.test\n'
  + 'Alan Turing,alan@example.test\nKatherine Johnson,kj@example.test\n'

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
  await inScope(() => importRoster({ kind: 'participant', csv: CSV, confirm: true, actor: ACTOR }))
})

afterEach(() => resetTeamPort())

async function teamWith(origin: 'REGISTRATION' | 'ORGANISER', size: number): Promise<number> {
  const team = origin === 'REGISTRATION'
    ? await tx((client) => teams().create({
      displayName: 'Formed', contactEmail: 'ada@example.test', actor: 'participant:1', client,
    }))
    : await teams().create({ displayName: 'Held', contactEmail: 'ada@example.test', actor: ACTOR })
  const people = (await listParticipants()).slice(0, size)
  for (const p of people) {
    await inScope(() => assign({ teamId: team.teamId, participantId: p.participantId, actor: ACTOR }))
  }
  return team.teamId
}

describe('removing a member', () => {
  it('is refused on a REGISTERED team at the minimum, naming the bound and the count', async () => {
    await teamWith('REGISTRATION', 3)
    const [first] = await listParticipants()
    await expect(inScope(() => unassign({ participantId: first!.participantId, actor: ACTOR })))
      .rejects.toThrow(/would leave 2, and a team needs at least 3/)
  })

  it('is allowed on a registered team ABOVE the minimum', async () => {
    await teamWith('REGISTRATION', 4)
    const [first] = await listParticipants()
    await expect(inScope(() => unassign({ participantId: first!.participantId, actor: ACTOR })))
      .resolves.toBeUndefined()
  })

  it('is allowed on an ORGANISER-held team of any size — the rule binds entrants, not the fixers', async () => {
    await teamWith('ORGANISER', 3)
    const [first] = await listParticipants()
    await expect(inScope(() => unassign({ participantId: first!.participantId, actor: ACTOR })))
      .resolves.toBeUndefined()
  })

  it('and the readiness checklist still NAMES the organiser team that is now too small', async () => {
    await teamWith('ORGANISER', 3)
    const [first] = await listParticipants()
    await inScope(() => unassign({ participantId: first!.participantId, actor: ACTOR }))
    const checks = await rosterReadiness()
    const size = checks.find((c) => c.id === 'roster_team_size')!
    expect(size.status).toBe('FAIL')
    expect(size.detail).toMatch(/Held \(2\)/)
  })
})
