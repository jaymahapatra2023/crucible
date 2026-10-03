/**
 * Human decisions and finalisation (E08-S04, E08-S05).
 *
 * This is where P0's first constraint has to hold under pressure: the system ranks, a person
 * decides, and the decision carries a name and a reason that survive. The tests concentrate on
 * the rules that exist precisely because someone will be in a hurry — a mandatory reason, an
 * immutable finalised list, and a refusal to lock while the cut band is unresolved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { startRun } from '../../src/modules/scoring/services/scoreRunService.js'
import { computeRanking } from '../../src/modules/scoring/services/rankingService.js'
import {
  decide, finalise, openShortlist, reopen, shortlistState,
} from '../../src/modules/review/services/shortlistService.js'
import { decisionHistory } from '../../src/modules/review/services/shortlistService.js'
import { exportShortlist } from '../../src/modules/review/services/shortlistExport.js'
import { reviewTable } from '../../src/modules/review/services/reviewTable.js'
import { query } from '../../src/db/pool.js'
import {
  ACTOR, inScope, originalityTurn, scoreTurn, seedCohort, type CohortFixture,
} from '../support/scoringFixtures.js'

let provider: FakeProvider
let cohort: CohortFixture
let cohortKey: string
let runId: number

const REASON = 'Reviewed the evidence for both runs and accept this placement.'

/** Decide every cut-band submission, which is part of what finalisation requires. */
async function decideBand(decision: 'SHORTLIST' | 'EXCLUDE' = 'SHORTLIST'): Promise<void> {
  const band = await query<{ submission_id: number }>(
    'SELECT submission_id FROM submission_composite WHERE run_index_id = $1 AND in_cut_band',
    [runId])
  for (const row of band.rows) {
    await decide({
      runIndexId: runId, submissionId: row.submission_id,
      decision, reason: REASON, actor: ACTOR,
    })
  }
}

/** Answer every caveat on the band — the other half of what finalisation requires. */
async function clearBandFlags(): Promise<void> {
  await query(
    `UPDATE review_flag rf
        SET dismissed_at = now(), dismissed_by = $2, dismissal_reason = $3
       FROM submission_composite sc
      WHERE sc.run_index_id = rf.run_index_id
        AND sc.submission_id = rf.submission_id
        AND rf.run_index_id = $1 AND sc.in_cut_band AND rf.dismissed_at IS NULL`,
    [runId, ACTOR, 'Reviewed against the evidence and accepted by the committee.'])
}

/** Everything finalisation requires: a decision and an answered caveat for each band entry. */
async function readyToFinalise(
  decision: 'SHORTLIST' | 'EXCLUDE' = 'SHORTLIST',
): Promise<void> {
  await decideBand(decision)
  await clearBandFlags()
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  cohortKey = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  cohort = await seedCohort({ count: 3 })

  // A tight cut line, so the band is small enough to reason about in a test.
  await inScope(() => setConfig('scoring.cut_line', 2, ACTOR))
  await inScope(() => setConfig('scoring.cut_band_size', 0, ACTOR))
  invalidateConfig()

  provider.setScript([4, 3, 2].flatMap((s) => [scoreTurn(s), originalityTurn(3)]))
  const outcome = await inScope(() => startRun({
    cohortKey, runIndex: 1, submissionIds: cohort.submissionIds, startedBy: ACTOR,
  }))
  runId = outcome.run.run_index_id
  await computeRanking(runId, ACTOR)
  await openShortlist(runId, ACTOR, 'Finals')
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

describe('recording a decision (E08-S04 acceptance 1)', () => {
  it('records SHORTLIST, EXCLUDE and HOLD with the actor and the reason', async () => {
    for (const [i, decision] of (['SHORTLIST', 'EXCLUDE', 'HOLD'] as const).entries()) {
      await decide({
        runIndexId: runId, submissionId: cohort.submissionIds[i]!,
        decision, reason: REASON, actor: 'organiser@test.local',
      })
    }

    const state = await shortlistState(runId)
    expect(state.counts).toMatchObject({ SHORTLIST: 1, EXCLUDE: 1, HOLD: 1 })
    expect(state.decisions[0]?.decided_by).toBe('organiser@test.local')
    expect(state.decisions[0]?.reason).toBe(REASON)
  })

  it('stores the RANK the submission held when the decision was taken', async () => {
    const decision = await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'SHORTLIST', reason: REASON, actor: ACTOR,
    })
    // Without this, a later re-ranking makes a recorded decision look arbitrary.
    expect(decision.rank_at_decision).toBe(1)
  })

  it('the DATABASE refuses a decision with a reason too short to be one', async () => {
    const shortlist = await query<{ shortlist_id: number }>(
      'SELECT shortlist_id FROM shortlist WHERE run_index_id = $1', [runId])
    await expect(query(
      `INSERT INTO shortlist_decision (shortlist_id, submission_id, decision, reason, decided_by)
       VALUES ($1, $2, 'SHORTLIST', 'ok', 'x')`,
      [shortlist.rows[0]!.shortlist_id, cohort.submissionIds[0]],
    )).rejects.toThrow()
  })

  it('REFUSES a decision about a team the ranking does not contain', async () => {
    await expect(decide({
      runIndexId: runId, submissionId: 999999,
      decision: 'SHORTLIST', reason: REASON, actor: ACTOR,
    })).rejects.toThrow(/not in the ranking/)
  })

  it('writes an audit row carrying the reason and the rank', async () => {
    await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'EXCLUDE', reason: REASON, actor: ACTOR,
    })

    const audit = await query<{ payload: { decision: string; rankAtDecision: number } }>(
      `SELECT payload FROM audit_event WHERE action = 'review.decision_recorded'`)
    expect(audit.rows[0]?.payload.decision).toBe('EXCLUDE')
    expect(audit.rows[0]?.payload.rankAtDecision).toBe(1)
  })

  it('a later decision REPLACES the earlier one rather than accumulating', async () => {
    await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'HOLD', reason: REASON, actor: ACTOR,
    })
    await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'SHORTLIST', reason: 'Checked the probe log; the build failure was ours.',
      actor: ACTOR,
    })

    const state = await shortlistState(runId)
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]?.decision).toBe('SHORTLIST')
    // Both acts are in the audit log, which is where the history lives.
    const audit = await query(
      `SELECT 1 FROM audit_event WHERE action = 'review.decision_recorded'`)
    expect(audit.rows).toHaveLength(2)
  })
})

describe('the override travels with the submission (acceptance 3)', () => {
  it('appears in the ranked review table', async () => {
    await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[1]!,
      decision: 'EXCLUDE', reason: 'Repository contains another team’s work; confirmed by hand.',
      actor: ACTOR,
    })

    const table = await reviewTable({ runIndexId: runId })
    const row = table.rows.find((r) => r.submission_id === cohort.submissionIds[1])
    expect(row?.decision).toBe('EXCLUDE')
    expect(row?.decision_reason).toMatch(/another team/)
  })

  it('is filterable in the database, so counts stay truthful', async () => {
    await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[1]!,
      decision: 'EXCLUDE', reason: REASON, actor: ACTOR,
    })

    const excluded = await reviewTable({ runIndexId: runId, filter: { decision: 'EXCLUDE' } })
    expect(excluded.total).toBe(1)
    expect(excluded.totalUnfiltered).toBe(3)
  })
})

describe('finalising (E08-S05)', () => {
  it('REFUSES while a cut-band submission has no decision (acceptance 3)', async () => {
    await expect(finalise({ runIndexId: runId, actor: ACTOR }))
      .rejects.toThrow(/unresolved/)
  })

  it('REFUSES while a cut-band submission still carries an unreviewed caveat', async () => {
    // The system-level definition of done is explicit: every flag in the cut band was reviewed
    // by a person and the review recorded. A decision taken without reading the caveats is the
    // unexamined acceptance the flag surface exists to prevent.
    await decideBand()

    const open = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM v_review_flags
        WHERE run_index_id = $1 AND NOT dismissed`, [runId])
    expect(open.rows[0]!.n).toBeGreaterThan(0)

    await expect(finalise({ runIndexId: runId, actor: ACTOR }))
      .rejects.toThrow(/unanswered caveat/)
  })

  it('names WHICH state is blocking, not merely that something is', async () => {
    await expect(finalise({ runIndexId: runId, actor: ACTOR }))
      .rejects.toThrow(/no decision recorded/)
  })

  it('REFUSES while a cut-band submission is on hold', async () => {
    const band = await query<{ submission_id: number }>(
      'SELECT submission_id FROM submission_composite WHERE run_index_id = $1 AND in_cut_band',
      [runId])
    for (const row of band.rows) {
      await decide({
        runIndexId: runId, submissionId: row.submission_id,
        decision: 'HOLD', reason: REASON, actor: ACTOR,
      })
    }

    await expect(finalise({ runIndexId: runId, actor: ACTOR }))
      .rejects.toThrow(/on hold/)
  })

  it('names WHICH submissions are blocking, rather than just refusing', async () => {
    await expect(finalise({ runIndexId: runId, actor: ACTOR }))
      .rejects.toMatchObject({ details: { blocking: expect.any(Array) } })
  })

  it('locks the shortlist and records the rubric versions in force (acceptance 1)', async () => {
    await readyToFinalise()
    const final = await finalise({ runIndexId: runId, actor: 'chair@test.local' })

    expect(final.status).toBe('FINAL')
    expect(final.finalised_by).toBe('chair@test.local')
    expect(final.rubric_versions[String(cohort.challengeId)]).toBe(1)
  })

  it('refuses to finalise twice', async () => {
    await readyToFinalise()
    await finalise({ runIndexId: runId, actor: ACTOR })
    await expect(finalise({ runIndexId: runId, actor: ACTOR })).rejects.toThrow(/already final/)
  })

  it('the DATABASE makes decisions immutable once final (acceptance 2)', async () => {
    await readyToFinalise()
    await finalise({ runIndexId: runId, actor: ACTOR })

    await expect(decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'EXCLUDE', reason: 'Changed my mind after the meeting.', actor: ACTOR,
    })).rejects.toThrow(/immutable/)
  })

  it('refuses a raw DELETE of a finalised decision too', async () => {
    await readyToFinalise()
    await finalise({ runIndexId: runId, actor: ACTOR })
    await expect(query('DELETE FROM shortlist_decision')).rejects.toThrow(/is FINAL/)
  })

  it('can be REOPENED, and says who did it and why', async () => {
    await readyToFinalise()
    await finalise({ runIndexId: runId, actor: ACTOR })

    const reopened = await reopen({
      runIndexId: runId, actor: 'chair@test.local',
      reason: 'A team appealed and produced the commit history we could not read.',
    })
    expect(reopened.status).toBe('OPEN')

    const audit = await query<{ payload: { reason: string } }>(
      `SELECT payload FROM audit_event WHERE action = 'review.shortlist_reopened'`)
    expect(audit.rows[0]?.payload.reason).toMatch(/appealed/)
  })

  it('accepts decisions again once reopened', async () => {
    await readyToFinalise()
    await finalise({ runIndexId: runId, actor: ACTOR })
    await reopen({ runIndexId: runId, actor: ACTOR, reason: 'Appeal upheld; revisiting.' })

    const decision = await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'EXCLUDE', reason: 'Appeal established the work predates the event window.',
      actor: ACTOR,
    })
    expect(decision.decision).toBe('EXCLUDE')
  })

  it('REFUSES to open a shortlist before a ranking exists', async () => {
    await query('DELETE FROM ranking_snapshot WHERE run_index_id = $1', [runId])
    await expect(openShortlist(runId, ACTOR)).rejects.toThrow(/no stored ranking/)
  })
})

describe('the export (E08-S05 acceptance 2)', () => {
  it('carries rank, composite, dimensions, flags, overrides and reasons', async () => {
    await decide({
      runIndexId: runId, submissionId: cohort.submissionIds[0]!,
      decision: 'SHORTLIST', reason: 'Strongest fidelity evidence in the cohort.', actor: ACTOR,
    })

    const csv = await exportShortlist(runId)
    const header = csv.split('\n')[0]!

    for (const column of [
      'rank_global', 'composite', 'challenge_fidelity', 'engineering_quality',
      'flag_codes', 'flag_messages', 'decision', 'decision_reason',
    ]) {
      expect(header, column).toContain(column)
    }
    expect(csv).toMatch(/Strongest fidelity evidence/)
  })

  it('spells flag messages out, since a spreadsheet has no schema beside it', async () => {
    const csv = await exportShortlist(runId)
    expect(csv).toMatch(/below the 15 needed to compare fidelity/)
  })

  it('KEEPS a dismissed flag and its reason rather than dropping it', async () => {
    await query(
      `UPDATE review_flag SET dismissed_at = now(), dismissed_by = 'r@test.local',
              dismissal_reason = 'Accepted: both challenges share absolute anchors.'
        WHERE run_index_id = $1 AND code = 'COHORT_BELOW_FLOOR'`, [runId])

    const csv = await exportShortlist(runId)
    expect(csv).toMatch(/Accepted: both challenges share absolute anchors/)
  })

  it('records the shortlist status and the rubric versions', async () => {
    await readyToFinalise()
    await finalise({ runIndexId: runId, actor: ACTOR })

    const csv = await exportShortlist(runId)
    expect(csv).toContain('"FINAL"')
    expect(csv).toMatch(new RegExp(`"\\{""${cohort.challengeId}"":1\\}"`))
  })

  it('leaves an undecided team BLANK rather than implying a decision', async () => {
    const csv = await exportShortlist(runId)
    const rows = csv.trim().split('\n').slice(1)
    // Five empty decision cells: decision, reason, by, at, rank.
    expect(rows.every((r) => r.includes('"","","","",""'))).toBe(true)
  })
})

describe('moving a team between shortlist, hold and exclude (E23)', () => {
  /** Any ranked submission; the move is about the decision, not about where it placed. */
  async function anyRanked(): Promise<number> {
    const row = await query<{ submission_id: number }>(
      'SELECT submission_id FROM submission_composite WHERE run_index_id = $1 LIMIT 1', [runId])
    return Number(row.rows[0]!.submission_id)
  }

  beforeEach(async () => { await openShortlist(runId, ACTOR) })

  it('lets a team be moved, and the standing decision is the latest', async () => {
    const submissionId = await anyRanked()
    await decide({ runIndexId: runId, submissionId, decision: 'SHORTLIST', reason: REASON, actor: ACTOR })
    await decide({
      runIndexId: runId, submissionId, decision: 'HOLD',
      reason: 'Provenance query raised; parking until the history is explained.', actor: 'reviewer@test.local',
    })

    const state = await shortlistState(runId)
    const standing = state.decisions.find((d) => d.submission_id === submissionId)!
    expect(standing.decision).toBe('HOLD')
    expect(standing.decided_by).toBe('reviewer@test.local')
  })

  it('KEEPS the decision it moved away from, with its author and reason', async () => {
    // The whole point. An appeal asks who decided what and in what order; an overwrite answers
    // only the last of those questions.
    const submissionId = await anyRanked()
    await decide({ runIndexId: runId, submissionId, decision: 'SHORTLIST', reason: REASON, actor: 'first@test.local' })
    await decide({
      runIndexId: runId, submissionId, decision: 'EXCLUDE',
      reason: 'Repository was force-pushed after the deadline; nothing to evaluate.',
      actor: 'second@test.local',
    })

    const history = await decisionHistory(runId, submissionId)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ decision: 'EXCLUDE', decided_by: 'second@test.local' })
    expect(history[1]).toMatchObject({ decision: 'SHORTLIST', decided_by: 'first@test.local' })
    expect(history[1]!.reason).toBe(REASON)
    expect(history[1]!.superseded_at).not.toBeNull()
    expect(history[0]!.superseded_at).toBeNull()
  })

  it('records a move AS a move in the audit trail, naming what it replaced', async () => {
    const submissionId = await anyRanked()
    await decide({ runIndexId: runId, submissionId, decision: 'SHORTLIST', reason: REASON, actor: ACTOR })
    await decide({
      runIndexId: runId, submissionId, decision: 'EXCLUDE',
      reason: 'Withdrew after the deadline; confirmed by email with the team.', actor: ACTOR,
    })

    const audit = await query<{ payload: { decision: string; supersedes: { decision: string } | null } }>(
      `SELECT payload FROM audit_event WHERE action = 'review.decision_recorded'
        ORDER BY event_id DESC LIMIT 1`)
    expect(audit.rows[0]!.payload.supersedes?.decision).toBe('SHORTLIST')
  })

  it('records a FIRST decision as superseding nothing', async () => {
    const submissionId = await anyRanked()
    await decide({ runIndexId: runId, submissionId, decision: 'HOLD', reason: REASON, actor: ACTOR })

    const audit = await query<{ payload: { supersedes: unknown } }>(
      `SELECT payload FROM audit_event WHERE action = 'review.decision_recorded'
        ORDER BY event_id DESC LIMIT 1`)
    expect(audit.rows[0]!.payload.supersedes).toBeNull()
  })

  it('keeps ONE standing decision however many times a team is moved', async () => {
    const submissionId = await anyRanked()
    for (const decision of ['SHORTLIST', 'HOLD', 'EXCLUDE', 'SHORTLIST'] as const) {
      await decide({
        runIndexId: runId, submissionId, decision,
        reason: `Moved to ${decision} after discussion with the committee.`, actor: ACTOR,
      })
    }

    const standing = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM shortlist_decision sd
         JOIN shortlist s ON s.shortlist_id = sd.shortlist_id
        WHERE s.run_index_id = $1 AND sd.submission_id = $2 AND sd.superseded_at IS NULL`,
      [runId, submissionId])
    expect(standing.rows[0]!.n).toBe(1)
    expect(await decisionHistory(runId, submissionId)).toHaveLength(4)
  })

  it('REFUSES to edit what was decided, at the database (P7.1)', async () => {
    const submissionId = await anyRanked()
    await decide({ runIndexId: runId, submissionId, decision: 'SHORTLIST', reason: REASON, actor: ACTOR })

    await expect(query(
      `UPDATE shortlist_decision sd SET decision = 'EXCLUDE'
         FROM shortlist s
        WHERE s.shortlist_id = sd.shortlist_id AND s.run_index_id = $1
          AND sd.submission_id = $2`,
      [runId, submissionId])).rejects.toThrow()
  })

  it('REFUSES to delete a decision rather than superseding it', async () => {
    const submissionId = await anyRanked()
    await decide({ runIndexId: runId, submissionId, decision: 'SHORTLIST', reason: REASON, actor: ACTOR })

    await expect(query(
      `DELETE FROM shortlist_decision sd USING shortlist s
        WHERE s.shortlist_id = sd.shortlist_id AND s.run_index_id = $1 AND sd.submission_id = $2`,
      [runId, submissionId])).rejects.toThrow()
  })

  it('still refuses any change once the shortlist is FINAL', async () => {
    await decideBand()
    await query(`UPDATE review_flag SET dismissed_at = now(), dismissed_by = 'x',
                        dismissal_reason = 'Reviewed and accepted by the committee.'
                  WHERE run_index_id = $1`, [runId])
    await finalise({ runIndexId: runId, actor: ACTOR })

    const submissionId = await anyRanked()
    await expect(decide({
      runIndexId: runId, submissionId, decision: 'HOLD',
      reason: 'Trying to move a team on a finalised list.', actor: ACTOR,
    })).rejects.toThrow()
  })
})
