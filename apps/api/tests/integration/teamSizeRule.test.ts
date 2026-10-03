/**
 * The team size rule, and the two readings of it (E42).
 *
 * The rule is 3 to 8. What is tested here is that the same numbers produce a REFUSAL on the public
 * path and a WARNING on the organiser's — because the failure this guards against is subtle: a
 * checklist that passes a team the registration endpoint would have rejected, leaving an organiser
 * certain everything is fine while an entrant is being turned away.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import {
  assertCanRemoveMember, assertTeamSize, sizeProblem, teamSizeBounds,
} from '../../src/modules/roster/services/teamSizeRule.js'
import { rosterReadiness } from '../../src/modules/roster/services/rosterReadiness.js'
import { teams } from '../../src/lib/ports/teamPort.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { assign } from '../../src/modules/roster/services/membershipService.js'
import { selectParticipantByEmail } from '../../src/modules/roster/db/rosterDb.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'size' }, fn)

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  installTeamPort()
})

describe('the rule is 3 to 8', () => {
  it('reads the bounds from configuration, not a literal', async () => {
    expect(await teamSizeBounds()).toEqual({ min: 3, max: 8 })
  })

  it('names the bound AND the actual count, so the reader knows which end they failed', () => {
    const bounds = { min: 3, max: 8 }
    expect(sizeProblem(2, bounds)).toBe('A team needs between 3 and 8 members; this one has 2.')
    expect(sizeProblem(9, bounds)).toBe('A team needs between 3 and 8 members; this one has 9.')
    expect(sizeProblem(3, bounds)).toBeNull()
    expect(sizeProblem(8, bounds)).toBeNull()
  })
})

describe('the public path REFUSES', () => {
  it('refuses a team below the minimum', async () => {
    await expect(assertTeamSize(2)).rejects.toThrow(/between 3 and 8 members; this one has 2/)
  })

  it('refuses a team above the maximum', async () => {
    await expect(assertTeamSize(9)).rejects.toThrow(/this one has 9/)
  })

  it('accepts both ends of the range', async () => {
    await expect(assertTeamSize(3)).resolves.toBeUndefined()
    await expect(assertTeamSize(8)).resolves.toBeUndefined()
  })

  it('refuses a removal that would break the rule, saying what to do instead', async () => {
    // A team AT the minimum is the interesting case: removal is permitted right up to the bound.
    await expect(assertCanRemoveMember(3)).rejects.toThrow(/would leave 2, and a team needs at least 3/)
    await expect(assertCanRemoveMember(3)).rejects.toThrow(/Add a replacement first/)
    await expect(assertCanRemoveMember(4)).resolves.toBeUndefined()
  })
})

describe('the organiser path only WARNS', () => {
  it('records a team of two rather than refusing it', async () => {
    // A half-formed team during setup is normal. Refusing to record one would describe a world
    // that does not exist.
    await inScope(() => importRoster({
      kind: 'participant',
      csv: 'full_name,email\nAda Lovelace,ada@example.test\nGrace Hopper,grace@example.test',
      confirm: true, actor: ACTOR,
    }))
    const team = await inScope(() => teams().create({
      displayName: 'Pair', contactEmail: 'pair@example.test', actor: ACTOR,
    }))

    for (const email of ['ada@example.test', 'grace@example.test']) {
      const person = await selectParticipantByEmail(email)
      await inScope(() => assign({
        teamId: team.teamId, participantId: person!.participantId, actor: ACTOR,
      }))
    }

    const check = (await rosterReadiness()).find((c) => c.id === 'roster_team_size')
    expect(check?.status).toBe('FAIL')
    expect(check?.detail).toMatch(/Pair \(2\)/)
    expect(check?.detail).toMatch(/outside 3–8/)
  })

  it('uses the SAME numbers the public path refuses on', async () => {
    // The failure this prevents: a checklist that passes a team registration would reject.
    const bounds = await teamSizeBounds()
    await inScope(() => teams().create({
      displayName: 'Empty', contactEmail: 'e@example.test', actor: ACTOR,
    }))

    const check = (await rosterReadiness()).find((c) => c.id === 'roster_team_size')
    expect(check?.detail).toContain(`${bounds.min}–${bounds.max}`)
  })
})
