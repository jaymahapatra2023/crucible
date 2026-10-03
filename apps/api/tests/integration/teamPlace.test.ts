/**
 * Where a team sat, shown where the team is named (E27-S03 acceptance 4).
 *
 * The acceptance criterion says room and coach appear "wherever a team is identified to an
 * organiser: the intake dashboard and the team review page". Both live in modules that do not own
 * these tables, so what is really being tested is that the port carries the fact across without
 * either module reaching into the roster's rows.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import {
  addCoach, addRoom, assignLogistics, installLogisticsPort,
} from '../../src/modules/roster/services/rosterService.js'
import { logistics, resetLogisticsPort } from '../../src/lib/ports/logisticsPort.js'
import { failingSubmissions } from '../../src/modules/submissions/services/intakeReport.js'
import { teams } from '../../src/lib/ports/teamPort.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'place' }, fn)

/** A team with a submission that will not validate — the row the dashboard exists to chase. */
async function failingTeam(name: string): Promise<number> {
  const team = await inScope(() => teams().create({
    displayName: name, contactEmail: `${name.toLowerCase()}@example.test`, actor: ACTOR,
  }))
  const challenge = await query<{ challenge_id: number }>(
    `INSERT INTO challenge (name, slug, status, created_by)
     VALUES ($1, $2, 'OPEN', 'fixture') RETURNING challenge_id`,
    [`Challenge ${name}`, `c-${name.toLowerCase()}`])
  await query(
    `INSERT INTO submission
       (team_name, team_id, challenge_id, repo_url, build_method, dockerfile_path,
        contact_email, validation_status, validation_detail, is_current, submitted_via)
     VALUES ($1, $2, $3, 'https://example.test/r', 'DOCKERFILE', 'Dockerfile',
             'c@example.test', 'UNREACHABLE', 'The repository could not be reached.',
             TRUE, 'ORGANISER')`,
    [name, team.teamId, challenge.rows[0]!.challenge_id])
  return team.teamId
}

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  installTeamPort()
  installLogisticsPort()
})

describe('the logistics port', () => {
  it('is a loud no-op when unregistered, never taking the caller down', async () => {
    // The opposite of teamPort on purpose: a room decides nothing, so a dashboard that chases
    // failing submissions must not refuse to load because nobody wired the roster.
    resetLogisticsPort()
    await expect(logistics().forTeams([1, 2])).resolves.toEqual(new Map())
    installLogisticsPort()
  })

  it('leaves a team with no room and no coach OUT, rather than returning a row of nulls', async () => {
    const teamId = await failingTeam('Alpha')
    expect(await logistics().forTeams([teamId])).toEqual(new Map())
  })

  it('carries a room given to a team', async () => {
    const teamId = await failingTeam('Alpha')
    const room = await inScope(() => addRoom({ label: 'Ada', location: 'First', actor: ACTOR }))
    await inScope(() => assignLogistics({ teamId, roomId: room.roomId, actor: ACTOR }))

    expect((await logistics().forTeams([teamId])).get(teamId)).toEqual({
      teamId, roomLabel: 'Ada', coachName: null,
    })
  })
})

describe('the intake dashboard', () => {
  it('says where to find a team it is telling an organiser to chase', async () => {
    const teamId = await failingTeam('Alpha')
    const room = await inScope(() => addRoom({ label: 'Ada', actor: ACTOR }))
    const coach = await inScope(() => addCoach({
      fullName: 'Margaret Hamilton', email: 'm@example.test', actor: ACTOR,
    }))
    await inScope(() => assignLogistics({
      teamId, roomId: room.roomId, coachId: coach.coachId, actor: ACTOR,
    }))

    const [row] = await failingSubmissions()
    expect(row?.teamName).toBe('Alpha')
    expect(row?.roomLabel).toBe('Ada')
    expect(row?.coachName).toBe('Margaret Hamilton')
  })

  it('says null, not a placeholder, for a team nobody has placed', async () => {
    await failingTeam('Alpha')
    const [row] = await failingSubmissions()

    // "Nobody has said" and "a room called none" are different facts (P5.1).
    expect(row?.roomLabel).toBeNull()
    expect(row?.coachName).toBeNull()
  })

  it('still lists the failing submission when no logistics port is registered', async () => {
    await failingTeam('Alpha')
    resetLogisticsPort()

    const rows = await failingSubmissions()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reason).toMatch(/could not be reached/)
    installLogisticsPort()
  })
})
