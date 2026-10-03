/**
 * Review and shortlist API contract tests (E08, P6.x, P8.1).
 *
 * The authorisation boundary is the substance here. Reading the evidence and deciding who
 * presents are different acts: a reviewer may read everything and set a caveat aside, but only
 * an organiser records a decision or locks the outcome.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import { openShortlist } from '../../src/modules/review/services/shortlistService.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let app: FastifyInstance
let organiser: TestUser
let reviewer: TestUser
let viewer: TestUser
let provider: FakeProvider
let cohort: CohortFixture
let runId: number

const REASON = 'Reviewed both runs against the evidence and accept this placement.'

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  app = await getApp()
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
  viewer = await makeUser('viewer')

  await inScope(() => setConfig('scoring.cut_line', 1, ACTOR))
  await inScope(() => setConfig('scoring.cut_band_size', 0, ACTOR))
  invalidateConfig()

  cohort = await seedCohort({ count: 3 })
  provider.setScript([4, 3, 2].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
  const outcome = await inScope(() => startRun({
    cohortKey: `api-review-${Date.now()}`, runIndex: 1,
    submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  runId = outcome.run.run_index_id
  await computeRanking(runId, ACTOR)
  await openShortlist(runId, ACTOR, 'Finals')
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

afterAll(async () => {
  await closeApp()
})

describe('authorisation (P8.1, P8.2)', () => {
  it('refuses every review endpoint without a token', async () => {
    for (const url of [
      `/api/v1/review/runs/${runId}/table`,
      `/api/v1/review/runs/${runId}/flags`,
      `/api/v1/review/runs/${runId}/shortlist`,
      `/api/v1/review/runs/${runId}/teams/${cohort.submissionIds[0]}`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401)
    }
  })

  it('refuses a VIEWER the ranked field — it carries team names beside positions', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/review/runs/${runId}/table`, headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('lets a reviewer read, dismiss AND decide (E23)', async () => {
    // Deliberately changed. This was organiser-only on the reasoning that reading the evidence
    // and deciding who presents are different acts — but the people who read the evidence are
    // the committee, and making an organiser transcribe their conclusion puts a person between
    // the judgement and the record of it. The record names whoever made it either way.
    const read = await app.inject({
      method: 'GET', url: `/api/v1/review/runs/${runId}/table`, headers: authHeader(reviewer),
    })
    const decided = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/decisions`,
      headers: authHeader(reviewer),
      payload: { submissionId: cohort.submissionIds[0], decision: 'SHORTLIST', reason: REASON },
    })

    expect(read.statusCode).toBe(200)
    expect(decided.statusCode).toBe(200)
    expect((decided.json() as { data: { decided_by: string } }).data.decided_by)
      .toBe(reviewer.email)
  })

  it('still reserves FINALISING the shortlist for an organiser', async () => {
    // Deciding about one team and closing the whole list are the acts that genuinely differ.
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/finalise`, headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a decision from a viewer', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/decisions`,
      headers: authHeader(viewer),
      payload: { submissionId: cohort.submissionIds[0], decision: 'SHORTLIST', reason: REASON },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a reviewer finalising the shortlist', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/finalise`, headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('the ranked table (E08-S01, E08-S06)', () => {
  it('returns rows with the breakdown and real backend counts', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/review/runs/${runId}/table?limit=1`,
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)

    const { data } = res.json() as {
      data: {
        rows: Array<{ dimensions: unknown[]; rank_global: number }>
        total: number; totalUnfiltered: number
        counts: { inCutBand: number; withOpenFlags: number }
      }
    }
    expect(data.rows).toHaveLength(1)
    // Three in the field, one on the page — and the response says three.
    expect(data.total).toBe(3)
    expect(data.rows[0]!.dimensions.length).toBeGreaterThan(0)
    expect(data.counts.withOpenFlags).toBe(3)
  })

  it('filters by challenge in the database', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/review/runs/${runId}/table?challengeId=${cohort.challengeId}`,
      headers: authHeader(reviewer),
    })
    expect((res.json() as { data: { total: number } }).data.total).toBe(3)
  })

  it('rejects an unknown decision filter with 400, not 500', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/review/runs/${runId}/table?decision=MAYBE`,
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('team detail (E08-S02)', () => {
  it('returns criteria, evidence, flags, probe and provenance together', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/review/runs/${runId}/teams/${cohort.submissionIds[0]}`,
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)

    const { data } = res.json() as {
      data: {
        submission: { repo_url: string }
        criteria: Array<{ evidence: unknown[] }>
        flags: unknown[]
        provenance: unknown
        runDifferences: unknown[]
      }
    }
    expect(data.submission.repo_url).toMatch(/^https:/)
    expect(data.criteria[0]!.evidence).not.toHaveLength(0)
    expect(data.flags).not.toHaveLength(0)
    expect(data.runDifferences).toEqual([])
    // Asserted explicitly because the web declares this shape SEPARATELY, by hand — nothing at
    // compile time links the two, so a change on one side can only be caught here. Widening
    // `provenanceFor` to carry a resolution once turned this into an object and broke the team
    // page with no type error at all.
    expect(Array.isArray(data.provenance)).toBe(true)
  })
})

describe('flags (E08-S03)', () => {
  it('lists them with their wording and an open count', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/review/runs/${runId}/flags?submissionId=${cohort.submissionIds[0]}`,
      headers: authHeader(reviewer),
    })
    const { data } = res.json() as {
      data: { flags: Array<{ message: string }>; open: number }
    }
    expect(data.open).toBeGreaterThan(0)
    expect(data.flags[0]!.message.length).toBeGreaterThan(60)
  })

  it('REFUSES a dismissal with no reason', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/flags/dismiss`,
      headers: authHeader(reviewer),
      payload: { submissionId: cohort.submissionIds[0], code: 'NOT_PROBED' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('REFUSES a reason too short to be one', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/flags/dismiss`,
      headers: authHeader(reviewer),
      payload: { submissionId: cohort.submissionIds[0], code: 'NOT_PROBED', reason: 'fine' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('dismisses with a real reason and audits it', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/flags/dismiss`,
      headers: authHeader(reviewer),
      payload: {
        submissionId: cohort.submissionIds[0], code: 'NOT_PROBED',
        reason: 'The stack is out of scope for probing this year; agreed with the chair.',
      },
    })
    expect(res.statusCode).toBe(200)

    const audit = await query(`SELECT 1 FROM audit_event WHERE action = 'review.flag_dismissed'`)
    expect(audit.rows).toHaveLength(1)
  })
})

describe('decisions and finalising (E08-S04, E08-S05)', () => {
  const decide = (submissionId: number, decision: string, reason = REASON) =>
    app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/decisions`,
      headers: authHeader(organiser), payload: { submissionId, decision, reason },
    })

  it('REFUSES a decision with no reason', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/decisions`,
      headers: authHeader(organiser),
      payload: { submissionId: cohort.submissionIds[0], decision: 'SHORTLIST' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('REFUSES a decision outside the allowed set', async () => {
    expect((await decide(cohort.submissionIds[0]!, 'MAYBE')).statusCode).toBe(400)
  })

  it('MOVES a team between states, and keeps what it moved from (E23)', async () => {
    const submissionId = cohort.submissionIds[0]!
    await decide(submissionId, 'SHORTLIST')
    await decide(submissionId, 'HOLD', 'Provenance query raised; parking until it is explained.')
    await decide(submissionId, 'EXCLUDE', 'Withdrew after the deadline, confirmed by email.')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/review/runs/${runId}/decisions/${submissionId}/history`,
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)

    const history = (res.json() as {
      data: Array<{ decision: string; superseded_at: string | null }>
    }).data
    expect(history.map((h) => h.decision)).toEqual(['EXCLUDE', 'HOLD', 'SHORTLIST'])
    // Exactly one stands; the rest are history.
    expect(history.filter((h) => h.superseded_at === null)).toHaveLength(1)
  })

  it('returns an empty history for a team nobody has decided about', async () => {
    // Distinct from a team that was decided and moved back — "nobody has looked" is its own
    // answer, and an empty list says it without inventing a decision.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/review/runs/${runId}/decisions/${cohort.submissionIds[1]}/history`,
      headers: authHeader(reviewer),
    })
    expect((res.json() as { data: unknown[] }).data).toEqual([])
  })

  it('records a decision and returns it', async () => {
    const res = await decide(cohort.submissionIds[0]!, 'SHORTLIST')
    expect(res.statusCode).toBe(200)
    const { data } = res.json() as { data: { decision: string; rank_at_decision: number } }
    expect(data.decision).toBe('SHORTLIST')
    expect(data.rank_at_decision).toBe(1)
  })

  it('REFUSES to finalise while the cut band is undecided (acceptance 3)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/finalise`,
      headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(412)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/unresolved/)
  })

  it('finalises once the band is decided AND its caveats answered, then refuses changes', async () => {
    await decide(cohort.submissionIds[0]!, 'SHORTLIST')

    // Deciding is half of it: the plan's definition of done also requires every flag in the
    // cut band to have been reviewed by a person and the review recorded.
    const blocked = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/finalise`,
      headers: authHeader(organiser),
    })
    expect(blocked.statusCode).toBe(412)
    expect(blocked.body).toMatch(/unanswered caveat/)

    await query(
      `UPDATE review_flag rf SET dismissed_at = now(), dismissed_by = 'chair@test.local',
              dismissal_reason = 'Reviewed against the evidence and accepted.'
         FROM submission_composite sc
        WHERE sc.run_index_id = rf.run_index_id AND sc.submission_id = rf.submission_id
          AND rf.run_index_id = $1 AND sc.in_cut_band`,
      [runId])

    const finalised = await app.inject({
      method: 'POST', url: `/api/v1/review/runs/${runId}/finalise`,
      headers: authHeader(organiser),
    })
    expect(finalised.statusCode).toBe(200)

    const changed = await decide(cohort.submissionIds[0]!, 'EXCLUDE')
    expect(changed.statusCode).toBe(409)
  })

  it('serves the appeal packet as a readable document (E09-S02)', async () => {
    await decide(cohort.submissionIds[0]!, 'EXCLUDE', 'Work predates the event window.')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/governance/runs/${runId}/appeal/${cohort.submissionIds[0]}`,
      headers: authHeader(organiser),
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/markdown/)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    expect(res.body).toContain('# Evaluation record')
    expect(res.body).toMatch(/Work predates the event window/)
    // The document says what the system did NOT do.
    expect(res.body).toMatch(/does not select or eliminate anyone/)
  })

  it('audits every appeal packet it generates (E09-S02 acceptance 3)', async () => {
    await app.inject({
      method: 'GET',
      url: `/api/v1/governance/runs/${runId}/appeal/${cohort.submissionIds[0]}`,
      headers: authHeader(organiser),
    })

    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'governance.appeal_packet_generated'`)
    expect(audit.rows).toHaveLength(1)
  })

  it('exports the shortlist with flags, overrides and reasons', async () => {
    await decide(cohort.submissionIds[0]!, 'SHORTLIST', 'Strongest evidence in the cohort.')

    const res = await app.inject({
      method: 'GET', url: `/api/v1/review/runs/${runId}/shortlist.csv`,
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.body).toContain('decision_reason')
    expect(res.body).toMatch(/Strongest evidence in the cohort/)
  })
})
