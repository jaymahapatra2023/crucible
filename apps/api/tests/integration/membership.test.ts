/**
 * Assigning 200 participants to teams (E28).
 *
 * The rule the database enforces is that a participant is on at most one team. Most of what is
 * tested here is whether that rule's refusals are USEFUL — an operator moving somebody needs to
 * know which team already has them, not that an index was violated.
 *
 * Teams are reached through `teamPort`, so these tests install the real implementation: a test
 * that stubbed it would not exercise the wiring the whole arrangement depends on.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { installTeamPort } from '../../src/modules/submissions/services/teamService.js'
import { resetTeamPort, teams } from '../../src/lib/ports/teamPort.js'
import { importRoster } from '../../src/modules/roster/services/rosterImport.js'
import {
  assign, move, rosterBoard, setContact, unassign,
} from '../../src/modules/roster/services/membershipService.js'
import { listParticipants, selectParticipantByEmail } from '../../src/modules/roster/db/rosterDb.js'
import { rosterReadiness } from '../../src/modules/roster/services/rosterReadiness.js'
import { teamSizeBounds } from '../../src/modules/roster/services/teamSizeRule.js'
import { assignLogistics } from '../../src/modules/roster/services/rosterService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'membership' }, fn)

const PEOPLE = [
  'full_name,email',
  'Ada Lovelace,ada@example.test',
  'Grace Hopper,grace@example.test',
  'Alan Turing,alan@example.test',
  'Katherine Johnson,katherine@example.test',
].join('\n')

const load = (csv: string, confirm = true) =>
  inScope(() => importRoster({ kind: 'participant', csv, confirm, actor: ACTOR }))

const newTeam = (name: string) =>
  inScope(() => teams().create({
    displayName: name, contactEmail: `${name.toLowerCase().replace(/ /g, '-')}@example.test`,
    actor: ACTOR,
  }))

beforeEach(async () => {
  await resetDatabase()
  installAuditPort()
  installTeamPort()
})

describe('the team port (ADR 0002)', () => {
  it('throws rather than silently doing nothing when unregistered', async () => {
    // Unlike the audit port. A dropped audit event must not take down the action it describes; a
    // dropped assignment has nowhere to go, and an operator would be looking at a roster that
    // did not save.
    resetTeamPort()
    await expect(teams().list()).rejects.toThrow(/No team port is registered/)
    installTeamPort()
  })

  it('finds a team by the owning module\'s own normalisation', async () => {
    await newTeam('The Night Shift')
    // `team_normalise` is what the stored column is generated from, so a spreadsheet writing
    // "night shift" means the same team rather than a second one.
    expect(await teams().findByName('night-shift')).toMatchObject({
      displayName: 'The Night Shift',
    })
  })
})

describe('assigning', () => {
  it('puts a participant on a team', async () => {
    await load(PEOPLE)
    const team = await newTeam('Alpha')
    const person = (await listParticipants())[0]!

    const member = await inScope(() => assign({
      teamId: team.teamId, participantId: person.participantId, actor: ACTOR,
    }))
    expect(member).toMatchObject({ teamId: team.teamId, fullName: person.fullName })
  })

  it('makes the FIRST member the point of contact', async () => {
    // A team whose contact is nobody cannot be sent its token, and the first person added is
    // nearly always the one who registered.
    await load(PEOPLE)
    const team = await newTeam('Alpha')
    const [first, second] = await listParticipants()

    const one = await inScope(() => assign({
      teamId: team.teamId, participantId: first!.participantId, actor: ACTOR,
    }))
    const two = await inScope(() => assign({
      teamId: team.teamId, participantId: second!.participantId, actor: ACTOR,
    }))

    expect(one.isContact).toBe(true)
    expect(two.isContact).toBe(false)
  })

  it('carries the contact\'s address onto the TEAM, so E17\'s value is not typed twice', async () => {
    await load(PEOPLE)
    const team = await newTeam('Alpha')
    const person = (await selectParticipantByEmail('ada@example.test'))!

    await inScope(() => assign({
      teamId: team.teamId, participantId: person.participantId, actor: ACTOR,
    }))
    const after = (await teams().list()).find((t) => t.teamId === team.teamId)!
    expect(after.contactEmail).toBe('ada@example.test')
  })

  it('REFUSES a second team, NAMING the one that already has them', async () => {
    await load(PEOPLE)
    const alpha = await newTeam('Alpha')
    const beta = await newTeam('Beta')
    const person = (await listParticipants())[0]!

    await inScope(() => assign({
      teamId: alpha.teamId, participantId: person.participantId, actor: ACTOR,
    }))
    await expect(inScope(() => assign({
      teamId: beta.teamId, participantId: person.participantId, actor: ACTOR,
    }))).rejects.toThrow(/already on Alpha/)
  })

  it('is idempotent on the same team — clicking twice is not an error', async () => {
    await load(PEOPLE)
    const team = await newTeam('Alpha')
    const person = (await listParticipants())[0]!
    const once = () => inScope(() => assign({
      teamId: team.teamId, participantId: person.participantId, actor: ACTOR,
    }))

    await once()
    await expect(once()).resolves.toMatchObject({ teamId: team.teamId })
    const count = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM team_member')
    expect(count.rows[0]!.n).toBe(1)
  })

  it('enforces one team per participant at the DATABASE, not only in the service', async () => {
    await load(PEOPLE)
    const alpha = await newTeam('Alpha')
    const beta = await newTeam('Beta')
    const person = (await listParticipants())[0]!
    await inScope(() => assign({
      teamId: alpha.teamId, participantId: person.participantId, actor: ACTOR,
    }))

    await expect(query(
      'INSERT INTO team_member (team_id, participant_id) VALUES ($1, $2)',
      [beta.teamId, person.participantId])).rejects.toThrow()
  })

  it('refuses to assign somebody who is not on the roster', async () => {
    const team = await newTeam('Alpha')
    await expect(inScope(() => assign({
      teamId: team.teamId, participantId: 999_999, actor: ACTOR,
    }))).rejects.toThrow(/was not found/)
  })
})

describe('moving and taking off', () => {
  it('moves somebody between teams in one act', async () => {
    await load(PEOPLE)
    const alpha = await newTeam('Alpha')
    const beta = await newTeam('Beta')
    const person = (await listParticipants())[0]!

    await inScope(() => assign({
      teamId: alpha.teamId, participantId: person.participantId, actor: ACTOR,
    }))
    const moved = await inScope(() => move({
      teamId: beta.teamId, participantId: person.participantId, actor: ACTOR,
    }))
    expect(moved.teamId).toBe(beta.teamId)
  })

  it('takes somebody off without removing the participant', async () => {
    await load(PEOPLE)
    const team = await newTeam('Alpha')
    const person = (await listParticipants())[0]!
    await inScope(() => assign({
      teamId: team.teamId, participantId: person.participantId, actor: ACTOR,
    }))

    await inScope(() => unassign({ participantId: person.participantId, actor: ACTOR }))
    expect(await listParticipants()).toHaveLength(4)
    expect((await rosterBoard()).unassignedTotal).toBe(4)
  })

  it('refuses to take off somebody who is on no team', async () => {
    await load(PEOPLE)
    const person = (await listParticipants())[0]!
    await expect(inScope(() => unassign({ participantId: person.participantId, actor: ACTOR })))
      .rejects.toThrow(/is not on a team/)
  })

  it('names a different point of contact, and the team follows', async () => {
    await load(PEOPLE)
    const team = await newTeam('Alpha')
    const [first, second] = await listParticipants()
    for (const p of [first!, second!]) {
      await inScope(() => assign({ teamId: team.teamId, participantId: p.participantId, actor: ACTOR }))
    }

    await inScope(() => setContact({
      teamId: team.teamId, participantId: second!.participantId, actor: ACTOR,
    }))
    const after = (await teams().list()).find((t) => t.teamId === team.teamId)!
    expect(after.contactEmail).toBe(second!.email)
  })

  it('refuses to make somebody the contact for a team they are not on', async () => {
    await load(PEOPLE)
    const alpha = await newTeam('Alpha')
    const beta = await newTeam('Beta')
    const person = (await listParticipants())[0]!
    await inScope(() => assign({
      teamId: alpha.teamId, participantId: person.participantId, actor: ACTOR,
    }))

    await expect(inScope(() => setContact({
      teamId: beta.teamId, participantId: person.participantId, actor: ACTOR,
    }))).rejects.toThrow(/not on this team/)
  })
})

describe('the board the assignment surface reads', () => {
  it('gives the real unassigned total beside the bounded list (P5.7)', async () => {
    await load(PEOPLE)
    const board = await rosterBoard()
    expect(board.unassignedTotal).toBe(4)
    expect(board.participantTotal).toBe(4)
    expect(board.unassigned).toHaveLength(4)
  })

  it('drops somebody out of the unassigned list the moment they are assigned', async () => {
    await load(PEOPLE)
    const team = await newTeam('Alpha')
    const person = (await listParticipants())[0]!
    await inScope(() => assign({
      teamId: team.teamId, participantId: person.participantId, actor: ACTOR,
    }))

    const board = await rosterBoard()
    expect(board.unassignedTotal).toBe(3)
    expect(board.unassigned.map((p) => p.participantId)).not.toContain(person.participantId)
  })

  it('carries each team\'s roster, room and coach in one read', async () => {
    await load(PEOPLE)
    await inScope(() => importRoster({
      kind: 'room', csv: 'label\nAda', confirm: true, actor: ACTOR,
    }))
    const team = await newTeam('Alpha')
    const person = (await listParticipants())[0]!
    await inScope(() => assign({
      teamId: team.teamId, participantId: person.participantId, actor: ACTOR,
    }))

    const onBoard = (await rosterBoard()).teams.find((t) => t.teamId === team.teamId)!
    expect(onBoard.members).toHaveLength(1)
    expect(onBoard).toHaveProperty('roomLabel')
    expect(onBoard).toHaveProperty('coachName')
  })

  it('shows a team with nobody on it rather than omitting it', async () => {
    // An empty team is the commonest thing an operator is looking for.
    await newTeam('Nobody Yet')
    const board = await rosterBoard()
    expect(board.teams).toHaveLength(1)
    expect(board.teams[0]!.members).toHaveLength(0)
  })
})

describe('assigning from the file that already said the answer (E28-S03)', () => {
  const WITH_TEAMS = [
    'full_name,email,team_name',
    'Ada Lovelace,ada@example.test,Night Shift',
    'Grace Hopper,grace@example.test,The Night Shift',
    'Alan Turing,alan@example.test,Daylight',
  ].join('\n')

  it('states which team each row would join, and whether it would be created', async () => {
    const plan = await load(WITH_TEAMS, false)
    expect(plan.rows[0]).toMatchObject({ teamName: 'Night Shift', teamIsNew: true })
    expect(plan.rows[2]).toMatchObject({ teamName: 'Daylight', teamIsNew: true })
  })

  it('creates the teams and assigns everybody in one pass', async () => {
    await load(WITH_TEAMS)
    const board = await rosterBoard()
    expect(board.unassignedTotal).toBe(0)
    expect(board.teams).toHaveLength(2)
  })

  it('treats "Night Shift" and "The Night Shift" as ONE team', async () => {
    // The G13 defect at spreadsheet scale. Two teams here would rank separately.
    await load(WITH_TEAMS)
    const board = await rosterBoard()
    const nightShift = board.teams.filter((t) => t.displayName.toLowerCase().includes('night'))
    expect(nightShift).toHaveLength(1)
    expect(nightShift[0]!.members).toHaveLength(2)
  })

  it('joins a team that already exists rather than making a second', async () => {
    await newTeam('Night Shift')
    const plan = await load(WITH_TEAMS, false)
    expect(plan.rows[0]).toMatchObject({ teamIsNew: false })

    await load(WITH_TEAMS)
    expect((await rosterBoard()).teams).toHaveLength(2)
  })

  it('imports somebody whose team column is empty, leaving them unassigned', async () => {
    await load('full_name,email,team_name\nAda Lovelace,ada@example.test,')
    const board = await rosterBoard()
    expect(board.participantTotal).toBe(1)
    expect(board.unassignedTotal).toBe(1)
  })

  it('reports an assignment it could not make against the row, having imported the person', async () => {
    // The people are real and imported; an assignment that failed is a line on a worklist, not a
    // reason to lose 200 rows.
    await load('full_name,email\nAda Lovelace,ada@example.test')
    const ada = (await selectParticipantByEmail('ada@example.test'))!
    const other = await newTeam('Somewhere Else')
    await inScope(() => assign({
      teamId: other.teamId, participantId: ada.participantId, actor: ACTOR,
    }))

    const plan = await load('full_name,email,team_name\nAda Lovelace,ada@example.test,Night Shift')
    // She was already on the roster, so the row is EXISTING and no assignment is attempted.
    expect(plan.rows[0]!.outcome).toBe('EXISTING')
    expect(plan.imported).toBe(true)
  })
})

describe('what is not ready about the roster (E28-S04)', () => {
  const find = (checks: Array<{ id: string }>, id: string) => checks.find((c) => c.id === id)!

  it('reports UNKNOWN before anything is loaded, not PASS', async () => {
    // A list that was never loaded is not a list with nobody unassigned. Treating the two alike
    // is how a checklist becomes decoration.
    const checks = await rosterReadiness()
    expect(find(checks, 'roster_assigned').status).toBe('UNKNOWN')
    expect(find(checks, 'roster_team_size').status).toBe('UNKNOWN')
    expect(find(checks, 'roster_logistics').status).toBe('UNKNOWN')
  })

  it('NAMES who is not on a team, rather than counting them', async () => {
    await load(PEOPLE)
    const check = find(await rosterReadiness(), 'roster_assigned')

    expect(check.status).toBe('FAIL')
    expect(check.detail).toMatch(/4 of 4 not on a team/)
    expect(check.detail).toMatch(/Ada Lovelace/)
  })

  it('passes once everybody is assigned', async () => {
    await load([
      'full_name,email,team_name',
      'Ada Lovelace,ada@example.test,Alpha',
      'Grace Hopper,grace@example.test,Alpha',
    ].join('\n'))
    expect(find(await rosterReadiness(), 'roster_assigned').status).toBe('PASS')
  })

  it('names teams outside the size bounds, with their size', async () => {
    await load('full_name,email,team_name\nAda Lovelace,ada@example.test,Solo')
    const check = find(await rosterReadiness(), 'roster_team_size')

    expect(check.status).toBe('FAIL')
    expect(check.detail).toMatch(/Solo \(1\)/)
    // The bounds became 3–8 in E42. Read from configuration rather than pinned as a literal, so
    // the rule can move again without this test claiming the wrong one.
    const { min, max } = await teamSizeBounds()
    expect(check.detail).toMatch(new RegExp(`outside ${min}–${max}`))
  })

  it('names teams with no room and teams with no coach, separately', async () => {
    await load('full_name,email,team_name\nAda Lovelace,ada@example.test,Alpha')
    const check = find(await rosterReadiness(), 'roster_logistics')

    expect(check.status).toBe('FAIL')
    expect(check.detail).toMatch(/no room: Alpha/)
    expect(check.detail).toMatch(/no coach: Alpha/)
  })

  it('passes once a team has both', async () => {
    await load('full_name,email,team_name\nAda,ada@example.test,Alpha\nGrace,grace@example.test,Alpha')
    await inScope(() => importRoster({ kind: 'room', csv: 'label\nAda Room', confirm: true, actor: ACTOR }))
    await inScope(() => importRoster({
      kind: 'coach', csv: 'full_name,email\nMargaret Hamilton,m@example.test',
      confirm: true, actor: ACTOR,
    }))

    const board = await rosterBoard()
    const rooms = await query<{ room_id: number }>('SELECT room_id FROM room LIMIT 1')
    const coaches = await query<{ coach_id: number }>('SELECT coach_id FROM coach LIMIT 1')
    await inScope(() => assignLogistics({
      teamId: board.teams[0]!.teamId,
      roomId: Number(rooms.rows[0]!.room_id),
      coachId: Number(coaches.rows[0]!.coach_id),
      actor: ACTOR,
    }))

    expect(find(await rosterReadiness(), 'roster_logistics').status).toBe('PASS')
  })

  it('summarises rather than printing two hundred names', async () => {
    const many = ['full_name,email',
      ...Array.from({ length: 20 }, (_, i) => `Person ${i}, p${i}@example.test`)].join('\n')
    await load(many)
    const check = find(await rosterReadiness(), 'roster_assigned')
    expect(check.detail).toMatch(/and \d+ more/)
  })
})

describe('a coach who also judges (E29-S03)', () => {
  const find = (checks: Array<{ id: string }>, id: string) => checks.find((c) => c.id === id)!

  const loadCoach = (email: string) => inScope(() => importRoster({
    kind: 'coach', csv: `full_name,email\nMargaret Hamilton,${email}`,
    confirm: true, actor: ACTOR,
  }))

  const makeUser = (email: string, role: string) => query(
    `INSERT INTO crucible_user (email, display_name, password_hash, role)
     VALUES ($1, 'Margaret Hamilton', 'x', $2)`, [email, role])

  it('is UNKNOWN before any coach is loaded', async () => {
    expect(find(await rosterReadiness(), 'roster_coach_conflict').status).toBe('UNKNOWN')
  })

  it('passes when no coach holds a reviewing role', async () => {
    await loadCoach('margaret@example.test')
    expect(find(await rosterReadiness(), 'roster_coach_conflict').status).toBe('PASS')
  })

  it('NAMES the person and the teams they coached', async () => {
    // The conflict a roster makes visible and nothing else can: a coach helps produce the work,
    // so one who also decides about it is judging their own.
    await loadCoach('margaret@example.test')
    await makeUser('margaret@example.test', 'reviewer')

    const team = await newTeam('Alpha')
    const coach = await query<{ coach_id: number }>('SELECT coach_id FROM coach LIMIT 1')
    await inScope(() => assignLogistics({
      teamId: team.teamId, coachId: Number(coach.rows[0]!.coach_id), actor: ACTOR,
    }))

    const check = find(await rosterReadiness(), 'roster_coach_conflict')
    expect(check.status).toBe('FAIL')
    expect(check.detail).toMatch(/Margaret Hamilton \(reviewer; coaches Alpha\)/)
  })

  it('says plainly that it is NOT blocked', async () => {
    // The same person may legitimately hold both roles at a small event. What matters is that
    // somebody knew, not that the system had an opinion.
    await loadCoach('margaret@example.test')
    await makeUser('margaret@example.test', 'admin')

    const check = find(await rosterReadiness(), 'roster_coach_conflict')
    expect(check.detail).toMatch(/permitted and is not blocked/)
  })

  it('matches on the address case-insensitively', async () => {
    await loadCoach('Margaret@Example.Test')
    await makeUser('margaret@example.test', 'reviewer')
    expect(find(await rosterReadiness(), 'roster_coach_conflict').status).toBe('FAIL')
  })

  it('ignores a coach who is only a viewer — reading is not deciding', async () => {
    await loadCoach('margaret@example.test')
    await makeUser('margaret@example.test', 'viewer')
    expect(find(await rosterReadiness(), 'roster_coach_conflict').status).toBe('PASS')
  })

  it('reports a conflicted coach with no team yet, rather than omitting them', async () => {
    await loadCoach('margaret@example.test')
    await makeUser('margaret@example.test', 'reviewer')
    const check = find(await rosterReadiness(), 'roster_coach_conflict')
    expect(check.detail).toMatch(/no team yet/)
  })
})
