/**
 * Chasing the teams that are not there yet (E50).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { registerMailProvider, resetMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { issueSubmissionToken } from '../../src/modules/submissions/services/submissionTokens.js'
import { chaseList, sendReminders } from '../../src/modules/submissions/services/reminderService.js'
import { openWindow } from '../../src/modules/submissions/services/windowService.js'
import { seedCohort, type CohortFixture } from '../support/scoringFixtures.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import { query } from '../../src/db/pool.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'remind' }, fn)
let cohort: CohortFixture
let sent: MailMessage[]

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  sent = []
  registerMailProvider({ name: 'fake', sends: true, async send(m) { sent.push(m); return { delivered: true, detail: 'ok', channel: 'email' } } })
  cohort = await seedCohort({ count: 2 })
  await setConfig('event.submit_url', 'https://crucible.example.org/submit', ACTOR)
  invalidateConfig()
  await inScope(() => openWindow({
    name: 'Event', opensAt: new Date(Date.now() - 3600_000), closesAt: new Date('2026-10-04T16:00:00Z'), actor: ACTOR,
  }))
})

afterEach(() => resetMailProvider())

describe('who is not there yet', () => {
  it('lists a registered team with no entry, and a team whose entry has unfixed problems', async () => {
    const idle = await inScope(() => issueSubmissionToken({ label: 'Idle Team', contactEmail: 'idle@test.local', issuedBy: ACTOR }))
    await query(
      `INSERT INTO preflight_run (submission_id, team_id, status, verdict, checks, triggered_by, finished_at)
       SELECT submission_id, team_id, 'COMPLETED', 'PROBLEMS',
              '[{"key":"build","label":"Build","status":"FAIL","summary":"x","remedy":"y"}]'::jsonb, 'submission', now()
         FROM submission WHERE submission_id = $1`, [cohort.submissionIds[0]])

    const list = await chaseList()
    expect(list.map((t) => [t.teamName, t.kind])).toEqual([
      ['Idle Team', 'NOT_SUBMITTED'], [expect.stringMatching(/^Team/), 'PROBLEMS'],
    ])
    expect(list.find((t) => t.teamId === idle.teamId)!.situation).toBe('Has not submitted.')
    expect(list.find((t) => t.kind === 'PROBLEMS')!.situation).toBe('Entry has problems: Build.')
  })

  it('is empty when everybody has submitted cleanly', async () => {
    expect(await chaseList()).toEqual([])
  })
})

describe('reminding', () => {
  it('sends the reminder with the deadline and the link, records it, and shows it as the last one', async () => {
    const idle = await inScope(() => issueSubmissionToken({ label: 'Idle Team', contactEmail: 'idle@test.local', issuedBy: ACTOR }))
    const rows = await inScope(() => sendReminders({ actor: ACTOR }))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ teamId: idle.teamId, kind: 'NOT_SUBMITTED', status: 'SENT', channel: 'email' })
    expect(sent[0]!.to).toBe('idle@test.local')
    expect(sent[0]!.subject).toMatch(/you have not submitted yet/)
    expect(sent[0]!.body).toContain('https://crucible.example.org/submit')
    expect(sent[0]!.body).toMatch(/Entries close at .*2026.*Eastern/)

    const list = await chaseList()
    expect(list[0]!.lastReminder).toMatchObject({ status: 'SENT', channel: 'email' })
  })

  it('reminds only the teams asked for', async () => {
    const a = await inScope(() => issueSubmissionToken({ label: 'Alpha', contactEmail: 'a@test.local', issuedBy: ACTOR }))
    await inScope(() => issueSubmissionToken({ label: 'Beta', contactEmail: 'b@test.local', issuedBy: ACTOR }))
    const rows = await inScope(() => sendReminders({ actor: ACTOR, teamIds: [a.teamId] }))
    expect(rows.map((r) => r.teamId)).toEqual([a.teamId])
    expect(sent).toHaveLength(1)
  })

  it('records a failure for a team nobody can reach, and refuses when there is nobody to remind', async () => {
    await inScope(() => issueSubmissionToken({ label: 'Silent', contactEmail: 'x@test.local', issuedBy: ACTOR }))
    await query(`UPDATE team SET contact_email = '' WHERE display_name = 'Silent'`)
    const rows = await inScope(() => sendReminders({ actor: ACTOR }))
    expect(rows[0]).toMatchObject({ status: 'FAILED', detail: expect.stringMatching(/No contact address/) })
    expect(sent).toHaveLength(0)

    await query(`DELETE FROM access_token`); await query(`DELETE FROM team WHERE display_name = 'Silent'`)
    await expect(inScope(() => sendReminders({ actor: ACTOR }))).rejects.toThrow(/Nobody to remind/)
  })
})
