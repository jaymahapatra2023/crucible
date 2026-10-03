/**
 * Coach sheets (E51): composed from what the evaluation recorded, scoped to the shortlist or
 * the cut line, sent to each coach for their own teams, and recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { registerMailProvider, resetMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { insertScoreRun, upsertCriterionScore } from '../../src/modules/scoring/db/scoringDb.js'
import { replaceRanking } from '../../src/modules/scoring/db/rankingDb.js'
import { decide, openShortlist } from '../../src/modules/review/services/shortlistService.js'
import { coachSheet, coachSheets, dispatchState, sendCoachSheets } from '../../src/modules/review/services/coachSheet.js'
import { renderSheetText } from '../../src/modules/review/services/coachSheetRender.js'
import { ACTOR, seedCohort, type CohortFixture } from '../support/scoringFixtures.js'
import { query } from '../../src/db/pool.js'

let cohort: CohortFixture
let runId: number
let sent: MailMessage[]
let criterionId: number
let teamIds: number[]

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  sent = []
  registerMailProvider({ name: 'fake', sends: true, async send(m) { sent.push(m); return { delivered: true, detail: 'ok', channel: 'email', providerRef: 'msg-1' } } })
  cohort = await seedCohort({ count: 3 })
  const run = await insertScoreRun({ runIndex: 1, cohortKey: 'coach-c', rubricVersions: {}, model: 't', ledgerRunId: null, startedBy: 'seed' })
  runId = run.run_index_id
  criterionId = Number((await query<{ criterion_id: number }>(
    'SELECT criterion_id FROM v_rubrics_criterion WHERE rubric_id = $1', [cohort.rubricId])).rows[0]!.criterion_id)
  teamIds = (await query<{ team_id: number }>(
    'SELECT team_id FROM submission WHERE submission_id = ANY($1::bigint[]) ORDER BY submission_id', [cohort.submissionIds]))
    .rows.map((r) => Number(r.team_id))

  const scores = [4, 1, 3]
  for (const [i, submissionId] of cohort.submissionIds.entries()) {
    await upsertCriterionScore({
      runIndexId: runId, submissionId, rubricId: cohort.rubricId, rubricVersion: 1, rubricHash: 'f'.repeat(64),
      scored: {
        criterionId, dimension: 'CHALLENGE_FIDELITY', rawScore: scores[i]!, nonScore: null, confidence: 80,
        rationale: i === 1 ? 'Errors are caught but swallowed. The retry helper is never called.' : 'Retries with backoff on the main path.',
        anchorMatched: null, contextBytes: 10, contextTruncated: false, filesSearched: 1, model: 't', attempts: 1, costUsd: 0,
        evidence: [{ path: 'src/retry.ts', lineStart: 3, lineEnd: 9, excerpt: 'withRetry', verdict: 'VERIFIED', verdictReason: 'found' }],
      },
    })
  }
  await replaceRanking(runId, cohort.submissionIds.map((id, i) => ({
    submissionId: id, challengeId: cohort.challengeId, composite: 90 - i * 20, fidelityRaw: null, fidelityNormalised: null,
    cohortSize: 3, normalisationMethod: 'PERCENTILE', rankGlobal: i + 1, rankInChallenge: i + 1, tied: false,
    weightCovered: 1, missingDimensions: [], partial: false, inCutBand: false, advisoryDecided: false, reviewReasons: [],
  })), { scoresCounted: 3, submissions: 3, cutLineUsed: 2, bandSizeUsed: 0, minCohortSize: 1, computedBy: 'seed' })

  // The first team has a room and a coach; the second has neither.
  await query(
    `WITH r AS (INSERT INTO room (label, location, capacity, created_by) VALUES ('Ada Room', 'First floor', 6, 'seed') RETURNING room_id),
          c AS (INSERT INTO coach (full_name, email, created_by) VALUES ('Margaret Hamilton', 'margaret@example.test', 'seed') RETURNING coach_id)
     INSERT INTO team_logistics (team_id, room_id, coach_id, updated_by) SELECT $1, r.room_id, c.coach_id, 'seed' FROM r, c`,
    [teamIds[0]])
})

afterEach(() => resetMailProvider())

describe('one sheet', () => {
  it('is composed from the record: who, where, the weakest finding as a question with its citation', async () => {
    const sheet = await coachSheet(runId, cohort.submissionIds[1]!)
    expect(sheet.teamName).toMatch(/^Team/)
    expect(sheet.coach).toBeNull()
    expect(sheet.standing).toEqual({ rankInRun: 2, finalRank: null, decision: null })
    expect(sheet.built.absent).toBe(true)
    expect(sheet.ran).toBeNull()
    expect(sheet.questions).toHaveLength(1)
    expect(sheet.questions[0]).toEqual({
      topic: 'CRITERION',
      because: 'On "Handles failures without losing work" the evaluation noted: Errors are caught but swallowed.',
      ask: 'How did you approach handles failures without losing work, and what would you do next on it?',
      evidence: 'src/retry.ts:3',
    })
    expect(sheet.questions.length).toBeLessThanOrEqual(5)
  })

  it('carries the room and the coach when the roster has them', async () => {
    const sheet = await coachSheet(runId, cohort.submissionIds[0]!)
    expect(sheet.room).toBe('Ada Room')
    expect(sheet.coach).toBe('Margaret Hamilton')
    expect(sheet.strengths[0]).toBe('Handles failures without losing work: Retries with backoff on the main path.')
  })

  it('is not found for a submission outside the run', async () => {
    await expect(coachSheet(runId, 999_999)).rejects.toThrow(/not found/i)
  })

  it('renders for a coach without the standing, and for the organiser with it', async () => {
    const sheet = await coachSheet(runId, cohort.submissionIds[0]!)
    const forCoach = renderSheetText(sheet, { forCoach: true })
    expect(forCoach).not.toContain('Standing:')
    expect(forCoach).toContain('QUESTIONS TO ASK')
    expect(forCoach).toContain('Use this sheet to ask, not to tell.')
    expect(renderSheetText(sheet, { forCoach: false })).toContain('Standing: rank 1 in run')
    // One page: no line runs past what a printed column holds.
    for (const line of forCoach.split('\n')) expect(line.length).toBeLessThanOrEqual(220)
  })
})

describe('which teams', () => {
  it('inside the cut line before any decision, in rank order', async () => {
    const sheets = await coachSheets(runId, 'cutline')
    expect(sheets.map((s) => s.standing.rankInRun)).toEqual([1, 2])
    expect(await coachSheets(runId, 'shortlist')).toEqual([])
  })

  it('the shortlisted once decisions exist', async () => {
    await openShortlist(runId, ACTOR, 'Finals')
    await decide({ runIndexId: runId, submissionId: cohort.submissionIds[2]!, decision: 'SHORTLIST', reason: 'Reviewed the evidence and accept this placement.', actor: ACTOR })
    const sheets = await coachSheets(runId, 'shortlist')
    expect(sheets.map((s) => s.submissionId)).toEqual([cohort.submissionIds[2]])
    expect(sheets[0]!.standing.decision).toBe('SHORTLIST')
  })
})

describe('sending', () => {
  it('emails each coach their own teams only, names the teams with no coach, and records the dispatch', async () => {
    const out = await sendCoachSheets({ runIndexId: runId, scope: 'cutline', actor: ACTOR })
    expect(out.uncoached).toEqual([expect.stringMatching(/^Team/)])
    expect(out.sent).toHaveLength(1)
    expect(out.sent[0]).toMatchObject({ status: 'SENT', teamIds: [teamIds[0]], providerRef: 'msg-1', sentBy: ACTOR })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('margaret@example.test')
    expect(sent[0]!.subject).toBe('Coach sheets for your 1 shortlisted team')
    expect(sent[0]!.body).toContain('Margaret Hamilton')
    expect(sent[0]!.body).toContain('QUESTIONS TO ASK')
    expect(sent[0]!.body).not.toContain('Standing:')
    expect(sent[0]!.body).not.toMatch(/rank \d/)

    const state = await dispatchState(runId)
    expect(state).toHaveLength(1)
    expect(state[0]!.status).toBe('SENT')
  })

  it('records a failed send as FAILED, redacted, and still sends the others', async () => {
    registerMailProvider({ name: 'flaky', sends: true, async send() { throw new Error('SMTP refused: token=secret-value') } })
    const out = await sendCoachSheets({ runIndexId: runId, scope: 'cutline', actor: ACTOR })
    expect(out.sent[0]!.status).toBe('FAILED')
    expect(out.sent[0]!.detail).toContain('SMTP refused')
  })

  it('refuses when nothing is in scope, with the reason', async () => {
    await expect(sendCoachSheets({ runIndexId: runId, scope: 'shortlist', actor: ACTOR })).rejects.toThrow(/Nothing is shortlisted yet/)
  })
})
