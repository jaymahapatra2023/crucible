/**
 * Creating a team from the assignment surface (E28-S02 acceptance 7).
 *
 * The behaviour worth testing is not that a row appears. It is that the two ways this can go wrong
 * are both refused BEFORE anything is written — a name that collides with an existing team only
 * after normalisation, and a first member who is already on another team. Either one leaving an
 * empty team behind would give an operator a puzzle to solve later with no record of why.
 *
 * Teams are reached through `teamPort`, so the real implementation is installed: stubbing it would
 * skip the cross-module wiring this whole arrangement rests on (ADR 0002).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { teams } from '../../src/lib/ports/teamPort.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import { createTeam, rosterBoard } from '../../src/modules/roster/services/membershipService.js'
import { selectParticipantByEmail } from '../../src/modules/roster/db/rosterDb.js'
import { rosterReadiness } from '../../src/modules/roster/services/rosterReadiness.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import type { RosterCheck } from '../../src/modules/roster/services/rosterReadiness.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'team-create' }, fn)

const PEOPLE = [
  'full_name,email',
  'Ada Lovelace,ada@example.test',
  'Grace Hopper,grace@example.test',
].join('\n')

const load = (csv: string) =>
  inScope(() => importRoster({ kind: 'participant', csv, confirm: true, actor: ACTOR }))

const personId = async (email: string): Promise<number> => {
  const found = await selectParticipantByEmail(email)
  if (!found) throw new Error(`No participant ${email}`)
  return found.participantId
}

const make = (displayName: string, participantId?: number) =>
  inScope(() => createTeam({
    displayName, ...(participantId !== undefined && { participantId }), actor: ACTOR,
  }))

const find = (checks: RosterCheck[], id: string): RosterCheck => {
  const found = checks.find((c) => c.id === id)
  if (!found) throw new Error(`No check ${id}`)
  return found
}

const teamCount = async (): Promise<number> => {
  const res = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM team')
  return res.rows[0]?.n ?? 0
}

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  installTeamPort()
})

describe('creating a team with its first member', () => {
  it('takes the named participant along as the point of contact', async () => {
    await load(PEOPLE)
    const created = await make('Night Shift', await personId('ada@example.test'))

    expect(created.team.displayName).toBe('Night Shift')
    expect(created.contact?.isContact).toBe(true)
    expect(created.contact?.email).toBe('ada@example.test')

    // The address reaches the team record too, so E17's token can be sent somewhere.
    expect(created.team.contactEmail).toBe('ada@example.test')
    const [team] = await teams().list()
    expect(team?.contactEmail).toBe('ada@example.test')
  })

  it('leaves the new team selected on the board with its one member', async () => {
    await load(PEOPLE)
    await make('Night Shift', await personId('ada@example.test'))

    const board = await rosterBoard()
    expect(board.teams).toHaveLength(1)
    expect(board.teams[0]?.members.map((m) => m.fullName)).toEqual(['Ada Lovelace'])
    // Ada is no longer waiting to be assigned, which is the count the operator is working down.
    expect(board.unassignedTotal).toBe(1)
  })

  it('records the creation against the team, naming the member by id and not by address', async () => {
    await load(PEOPLE)
    const ada = await personId('ada@example.test')
    const created = await make('Night Shift', ada)

    const audit = await query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_event
        WHERE subject_type = 'team' AND subject_id = $1 AND action = 'roster.team_created'`,
      [String(created.team.teamId)])

    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.payload).toEqual({ withParticipantId: ada })
    // P8.3: an address in an audit payload is an address in a log aggregator.
    expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain('ada@example.test')
  })
})

describe('refusals, none of which leave a team behind', () => {
  it('refuses a name that is the same team after normalisation, and names it', async () => {
    await make('Night Shift')
    await expect(make('  the night-shift ')).rejects.toThrow(/Night Shift already exists/)
    expect(await teamCount()).toBe(1)
  })

  it('refuses a first member who is already on another team, creating nothing', async () => {
    await load(PEOPLE)
    const ada = await personId('ada@example.test')
    await make('Alpha', ada)

    await expect(make('Beta', ada)).rejects.toThrow(/Ada Lovelace is already on Alpha/)
    // The point of doing the check first: "Beta" must not exist as an empty leftover.
    expect(await teamCount()).toBe(1)
    expect((await teams().list()).map((t) => t.displayName)).toEqual(['Alpha'])
  })

  it('refuses a participant who does not exist', async () => {
    await expect(make('Ghost Team', 9_999)).rejects.toThrow(/Participant 9999 was not found/)
    expect(await teamCount()).toBe(0)
  })
})

describe('a team nobody can be written to', () => {
  it('is reported by name, saying it is empty', async () => {
    await make('Night Shift')
    const check = find(await rosterReadiness(), 'roster_team_contact')

    expect(check.status).toBe('FAIL')
    expect(check.detail).toMatch(/Night Shift \(nobody on it\)/)
  })

  it('passes once the team has a member whose address it can use', async () => {
    await load(PEOPLE)
    await make('Night Shift', await personId('ada@example.test'))

    expect(find(await rosterReadiness(), 'roster_team_contact').status).toBe('PASS')
  })

  it('is UNKNOWN rather than PASS when no team exists', async () => {
    // A question that was never asked is not a question answered yes (P5.1).
    expect(find(await rosterReadiness(), 'roster_team_contact').status).toBe('UNKNOWN')
  })

  it('catches a blank address arriving from an import, not only from this screen', async () => {
    // The import writes '' for a row with no email, and an empty string in a column nobody reads
    // is the defect this codebase keeps finding.
    await inScope(() => teams().create({
      displayName: 'Imported', contactEmail: '', actor: ACTOR,
    }))
    expect(find(await rosterReadiness(), 'roster_team_contact').detail).toMatch(/Imported/)
  })
})
