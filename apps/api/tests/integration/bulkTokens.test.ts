/**
 * Registering a cohort from one file (E20).
 *
 * Issuing a token IS registering a team (E17-S01), so this is bulk registration. What makes it
 * more than a loop is the plaintext: a token is shown once and only its SHA-256 is stored, so
 * fifty tokens in one response are fifty chances to lose a team's entry.
 *
 * Everything below is therefore about refusing rather than half-doing — and about the operator
 * seeing what will happen before it happens.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { bulkIssue, toCsv } from '../../src/modules/submissions/services/bulkTokens.js'
import { issueSubmissionToken, verifySubmissionToken } from '../../src/modules/submissions/services/submissionTokens.js'
import { getTeams } from '../../src/modules/submissions/services/teamService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'bulk' }, fn)

const run = (csv: string, confirm = false) =>
  inScope(() => bulkIssue({ csv, confirm, actor: ACTOR }))

const FILE = [
  'team_name,contact_email',
  'The Night Shift,night@team.test',
  'Daylight Robbery,day@team.test',
  'Mercury Rising,merc@team.test',
].join('\n')

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
})

describe('the plan, before anything is written', () => {
  it('says what each row would do', async () => {
    const plan = await run(FILE)
    expect(plan.rows.map((r) => r.outcome)).toEqual(['NEW', 'NEW', 'NEW'])
    expect(plan.summary).toMatchObject({ total: 3, new: 3, existing: 0, invalid: 0, duplicate: 0 })
  })

  it('writes NOTHING until it is confirmed', async () => {
    await run(FILE)
    expect(await getTeams()).toHaveLength(0)
  })

  it('returns no token on a plan — there is nothing to lose yet', async () => {
    const plan = await run(FILE)
    expect(plan.rows.every((r) => r.token === null)).toBe(true)
    expect(plan.issued).toBe(false)
  })

  it('recognises a team that already exists, and says it would REPLACE their token', async () => {
    await inScope(() => issueSubmissionToken({
      label: 'Night Shift', contactEmail: 'ns@team.test', issuedBy: ACTOR,
    }))

    const plan = await run(FILE)
    expect(plan.rows[0]).toMatchObject({ outcome: 'EXISTING' })
    expect(plan.rows[0]!.detail).toMatch(/Already registered as "Night Shift"/)
    expect(plan.rows[0]!.detail).toMatch(/REPLACEMENT token/)
  })

  it('matches an existing team the way the database does, not by exact spelling', async () => {
    // "Night Shift" and "The Night Shift" normalise the same. Creating a second team here is
    // exactly the G13 defect, at fifty times the scale.
    await inScope(() => issueSubmissionToken({
      label: 'night-shift', contactEmail: 'ns@team.test', issuedBy: ACTOR,
    }))
    expect((await run(FILE)).rows[0]!.outcome).toBe('EXISTING')
  })

  it('catches the same team appearing TWICE in one file, naming the earlier line', async () => {
    const plan = await run([
      'team_name,contact_email',
      'Night Shift,a@team.test',
      'The Night Shift,b@team.test',
    ].join('\n'))

    expect(plan.rows[1]!.outcome).toBe('DUPLICATE')
    expect(plan.rows[1]!.detail).toMatch(/appears on line 2/)
  })

  it('names what is wrong with a row, per row', async () => {
    const plan = await run([
      'team_name,contact_email',
      'A,short@team.test',
      'No Email,',
      'Bad Email,not-an-address',
      'Fine Team,fine@team.test',
    ].join('\n'))

    expect(plan.rows.map((r) => r.outcome)).toEqual(['INVALID', 'INVALID', 'INVALID', 'NEW'])
    expect(plan.rows[0]!.detail).toMatch(/too short/)
    expect(plan.rows[1]!.detail).toMatch(/no account/)
    expect(plan.rows[2]!.detail).toMatch(/not an email address/)
  })

  it('reports the line in the FILE, so a row can be found and fixed', async () => {
    const plan = await run(['team_name,contact_email', 'A,x@team.test'].join('\n'))
    expect(plan.rows[0]!.line).toBe(2)
  })
})

describe('the file itself', () => {
  it('accepts the column names people actually type', async () => {
    const plan = await run('Team,Email\nMercury Rising,merc@team.test')
    expect(plan.rows[0]).toMatchObject({ teamName: 'Mercury Rising', outcome: 'NEW' })
  })

  it('keeps a comma inside a quoted team name', async () => {
    const plan = await run('team_name,contact_email\n"Smith, Jones & Co",sj@team.test')
    expect(plan.rows[0]!.teamName).toBe('Smith, Jones & Co')
  })

  it('REFUSES a file with no header naming the columns', async () => {
    await expect(run('Night Shift,night@team.test')).rejects.toThrow(/header row is missing/)
  })

  it('REFUSES a header with no teams under it', async () => {
    await expect(run('team_name,contact_email')).rejects.toThrow(/header and no teams/)
  })

  it('REFUSES an empty file as EMPTY, not as a bad header', async () => {
    // Whitespace parses as one blank-ish row, so without a check up front this is refused for a
    // missing column — which reads as though the header is wrong rather than absent.
    await expect(run('   ')).rejects.toThrow(/file is empty/)
    await expect(run('')).rejects.toThrow(/file is empty/)
  })

  it('REFUSES more teams than the configured ceiling, saying how to raise it', async () => {
    await inScope(() => setConfig('submissions.max_bulk_tokens', 2, ACTOR))
    invalidateConfig()
    await expect(run(FILE)).rejects.toThrow(/at most 2 may be registered/)
    await expect(run(FILE)).rejects.toThrow(/max_bulk_tokens/)
  })
})

describe('issuing', () => {
  it('creates every team and returns every token, once', async () => {
    const plan = await run(FILE, true)

    expect(plan.issued).toBe(true)
    expect(await getTeams()).toHaveLength(3)
    expect(plan.rows.every((r) => r.token?.startsWith('crs_'))).toBe(true)
    expect(new Set(plan.rows.map((r) => r.token)).size).toBe(3)
  })

  it('issues tokens that actually work, bound to the right team', async () => {
    const plan = await run(FILE, true)
    const identity = await verifySubmissionToken(plan.rows[0]!.token!)
    expect(identity.teamName).toBe('The Night Shift')
    expect(identity.teamId).toBe(plan.rows[0]!.teamId)
  })

  it('reissues for an existing team instead of creating a second', async () => {
    const first = await inScope(() => issueSubmissionToken({
      label: 'Night Shift', contactEmail: 'ns@team.test', issuedBy: ACTOR,
    }))
    const plan = await run(FILE, true)

    expect(await getTeams()).toHaveLength(3)
    expect(plan.rows[0]!.teamId).toBe(first.teamId)
    // The old token is untouched — revoking is a separate, deliberate act.
    expect((await verifySubmissionToken(first.token)).teamId).toBe(first.teamId)
  })

  it('REFUSES THE WHOLE FILE when any row cannot be acted on', async () => {
    // Issuing the good rows would leave an operator reconciling which of their teams exist
    // against a file that does not say.
    const plan = await run([
      'team_name,contact_email',
      'Good Team,good@team.test',
      'Bad Email,nope',
    ].join('\n'), true)

    expect(plan.issued).toBe(false)
    expect(plan.refusal).toMatch(/Nothing was issued/)
    expect(await getTeams()).toHaveLength(0)
  })

  it('leaves NOTHING behind when the issue fails part way', async () => {
    // One transaction. Two teams created and the third failing would leave two plaintexts that
    // were never returned to anybody — tokens that exist and nobody holds.
    await query('ALTER TABLE access_token ADD CONSTRAINT tmp_refuse_all CHECK (false) NOT VALID')
    try {
      await expect(run(FILE, true)).rejects.toThrow()
      expect(await getTeams()).toHaveLength(0)
    } finally {
      await query('ALTER TABLE access_token DROP CONSTRAINT tmp_refuse_all')
    }
  })

  it('records the issue in the audit trail WITHOUT the tokens (P8.3)', async () => {
    const plan = await run(FILE, true)
    const audit = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_event WHERE action = 'submissions.tokens_bulk_issued'`)

    expect(audit.rows[0]!.payload).toMatchObject({ issued: 3, created: 3, reissued: 0 })
    const serialised = JSON.stringify(audit.rows)
    for (const row of plan.rows) expect(serialised).not.toContain(row.token)
  })

  it('records each token individually too, so a single issue and a bulk one look the same', async () => {
    await run(FILE, true)
    const individual = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event WHERE action = 'submissions.token_issued'`)
    expect(individual.rows[0]!.n).toBe(3)
  })
})

describe('the file an operator sends out from', () => {
  it('carries the token beside the team and the contact', async () => {
    const plan = await run(FILE, true)
    const csv = toCsv(plan)

    expect(csv.split('\n')[0]).toBe('"team_name","contact_email","token","status"')
    expect(csv).toContain(plan.rows[0]!.token!)
    expect(csv).toContain('night@team.test')
  })

  it('says which rows are replacements, so an old token is known to be superseded', async () => {
    await inScope(() => issueSubmissionToken({
      label: 'Night Shift', contactEmail: 'ns@team.test', issuedBy: ACTOR,
    }))
    const csv = toCsv(await run(FILE, true))
    expect(csv).toMatch(/"The Night Shift","night@team\.test","crs_[^"]+","replacement"/)
  })

  it('neutralises a team name a spreadsheet would execute', async () => {
    const plan = await run('team_name,contact_email\n=cmd|calc,x@team.test', true)
    expect(toCsv(plan)).toContain(`"'=cmd|calc"`)
  })
})
