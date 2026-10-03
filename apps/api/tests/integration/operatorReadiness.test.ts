/**
 * Operator readiness (E19).
 *
 * Two settings shipped unset and silently disabled what depended on them. Without an evaluation
 * date the dry run could not be shown to have happened early enough; without an event window
 * provenance could not flag work committed outside it, and the 40% threshold beside it had
 * nothing to apply to. Neither absence appeared anywhere an operator would look.
 *
 * And flagged commit histories had a query returning them and nothing that called it, so they
 * surfaced one team at a time with no way to work through them or to record a conclusion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig } from '../../src/modules/platform/services/configService.js'
import { readinessReport } from '../../src/modules/platform/services/readinessReport.js'
import {
  resolveProvenance, selectFlaggedProvenance,
} from '../../src/modules/scans/db/scanDb.js'
import { ACTOR, inScope } from '../support/scoringFixtures.js'
import { query } from '../../src/db/pool.js'

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
})

afterEach(() => invalidateConfig())

const eventCheck = async () =>
  (await readinessReport('any-cohort')).checks.find((c) => c.id === 'event')!

describe('unset event configuration (E19-S02)', () => {
  it('is reported as UNKNOWN, not FAIL — nothing went wrong, nothing was decided', async () => {
    const check = await eventCheck()
    expect(check.status).toBe('UNKNOWN')
  })

  it('still counts against readiness, so it cannot be ignored', async () => {
    const report = await readinessReport('any-cohort')
    expect(report.ready).toBe(false)
  })

  it('names the specific settings, so it is actionable rather than a complaint', async () => {
    const check = await eventCheck()
    expect(check.detail).toMatch(/event\.evaluation_date/)
    expect(check.detail).toMatch(/scans\.event_window/)
  })

  it('says what each unset setting costs', async () => {
    const check = await eventCheck()
    expect(check.detail).toMatch(/dry run cannot be shown to have happened early enough/i)
    expect(check.detail).toMatch(/provenance cannot flag work committed outside it/i)
  })

  it('passes once both are set', async () => {
    await inScope(() => setConfig('event.evaluation_date', '2026-11-14', ACTOR))
    await inScope(() => setConfig('scans.event_window', {
      startsAt: '2026-11-14T09:00:00Z', endsAt: '2026-11-15T17:00:00Z',
    }, ACTOR))
    invalidateConfig()

    const check = await eventCheck()
    expect(check.status).toBe('PASS')
    expect(check.detail).toMatch(/2026-11-14/)
  })

  it('still reports UNKNOWN when only one of the two is set', async () => {
    await inScope(() => setConfig('event.evaluation_date', '2026-11-14', ACTOR))
    invalidateConfig()

    const check = await eventCheck()
    expect(check.status).toBe('UNKNOWN')
    expect(check.detail).toMatch(/scans\.event_window/)
    expect(check.detail).not.toMatch(/event\.evaluation_date/)
  })
})

describe('the provenance queue (E19-S03)', () => {
  async function seedFlagged(submissionId: number, pct: number) {
    await query(
      `INSERT INTO provenance
         (submission_id, scan_id, total_commits, commits_in_window, commits_out_of_window,
          distinct_authors, authors, largest_single_commit_pct, history_truncated, flags)
       VALUES ($1, $1, 12, 8, 4, 2, ARRAY['a','b'], $2, FALSE,
               '[{"code":"SINGLE_COMMIT","message":"One commit contributed most of the code."}]'::jsonb)`,
      [submissionId, pct])
  }

  it('lists flagged histories, most concentrated first', async () => {
    await seedFlagged(1, 40)
    await seedFlagged(2, 90)

    const queue = await selectFlaggedProvenance()
    expect(queue.map((r) => Number(r.submission_id))).toEqual([2, 1])
  })

  it('records what a person concluded, with who concluded it', async () => {
    await seedFlagged(1, 90)
    await resolveProvenance({
      submissionId: 1,
      reason: 'The team squashed their history before submitting; the authors check out.',
      actor: ACTOR,
    })

    const queue = await selectFlaggedProvenance()
    expect(queue[0]!.resolved).toBe(true)
    expect(queue[0]!.resolution_reason).toMatch(/squashed their history/)
    expect(queue[0]!.resolved_by).toBe(ACTOR)
  })

  it('REFUSES a conclusion too short to be one, at the database', async () => {
    await seedFlagged(1, 90)
    await expect(
      resolveProvenance({ submissionId: 1, reason: 'fine', actor: ACTOR }),
    ).rejects.toThrow()
  })

  it('keeps a resolved entry in the list rather than hiding it', async () => {
    // A reader must be able to tell "somebody looked and was satisfied" from "nobody has looked
    // yet" — the same distinction the non-scores and the discovery tiles exist to protect.
    await seedFlagged(1, 90)
    await resolveProvenance({
      submissionId: 1, reason: 'Checked with the team; the history is genuine.', actor: ACTOR,
    })

    const queue = await selectFlaggedProvenance()
    expect(queue).toHaveLength(1)
  })

  it('sorts unresolved ahead of resolved, whatever the percentages say', async () => {
    await seedFlagged(1, 95)
    await seedFlagged(2, 50)
    await resolveProvenance({
      submissionId: 1, reason: 'Reviewed and satisfied; the author list is consistent.',
      actor: ACTOR,
    })

    const queue = await selectFlaggedProvenance()
    expect(Number(queue[0]!.submission_id)).toBe(2)
  })

  it('allows only one standing conclusion per submission', async () => {
    await seedFlagged(1, 90)
    await resolveProvenance({
      submissionId: 1, reason: 'Looked at the history and it is fine.', actor: ACTOR,
    })
    await expect(
      resolveProvenance({ submissionId: 1, reason: 'Looked again, still fine.', actor: ACTOR }),
    ).rejects.toThrow()
  })

  it('does NOT exclude the submission — these are flags', async () => {
    // E04-S06 is explicit, and there is deliberately no path here that could exclude anything.
    await seedFlagged(1, 90)
    await resolveProvenance({
      submissionId: 1, reason: 'Concentrated but legitimate; confirmed with the team.',
      actor: ACTOR,
    })

    const still = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM provenance WHERE submission_id = 1')
    expect(still.rows[0]!.n).toBe(1)
  })
})
