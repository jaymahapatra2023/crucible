/**
 * Discovery at cohort scale (E15).
 *
 * Discovery made seven sequential model calls inside one HTTP request, opened no ledger run,
 * and was not a batch stage. Three consequences followed from that one omission: no progress or
 * resume, spend outside every ceiling, and — the one that matters — a fifty-team cohort needing
 * fifty manual triggers, where any that were missed produced submissions scored on LESS context
 * than their competitors, in the same ranking, silently.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { ACTOR, inScope, scanResult, seedCohort, seedScan } from '../support/scoringFixtures.js'
import { DISCOVERY_SOURCE, discoveryResponder } from '../support/discoveryFixtures.js'
import { discoverSubmission } from '../../src/modules/discovery/services/discoveryService.js'
import { coverageFor } from '../../src/modules/discovery/services/discoveryCoverage.js'
import { STAGES } from '../../src/modules/batch/services/batchOrchestrator.js'
import { query } from '../../src/db/pool.js'

let provider: FakeProvider
let submissionId: number

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
  provider.setResponder(discoveryResponder())
  await setFlag('feature.discovery.enabled', true, ACTOR)

  const cohort = await seedCohort({ count: 1, files: DISCOVERY_SOURCE })
  submissionId = cohort.submissionIds[0]!
  await query('DELETE FROM scan WHERE submission_id = $1', [submissionId])
  await seedScan(submissionId, scanResult(DISCOVERY_SOURCE))
})

afterEach(() => {
  restoreProviders()
  resetGateway()
})

const discover = (runId?: number) => inScope(() => discoverSubmission({
  submissionId, actor: ACTOR, ...(runId !== undefined && { runId }),
}))

describe('discovery opens a run (E15-S01)', () => {
  it('opens a ledger run of its own when nobody supplied one', async () => {
    await discover()
    const runs = await query<{ run_id: number; kind: string; status: string }>(
      `SELECT run_id, kind, status FROM run WHERE kind = 'DISCOVERY'`)

    expect(runs.rows).toHaveLength(1)
    expect(runs.rows[0]!.status).toBe('SUCCEEDED')
  })

  it('records a stage result per concern, so progress is persisted and not only published', async () => {
    // A websocket message is gone on reload, which is exactly when somebody checks on a long
    // run. The ledger is what survives.
    await discover()
    const stages = await query<{ subject_id: string; outcome: string }>(
      `SELECT subject_id, outcome FROM run_stage_result
        WHERE stage = 'discovery.concern' ORDER BY subject_id`)

    expect(stages.rows).toHaveLength(7)
    expect(stages.rows.every((r) => r.outcome === 'ok')).toBe(true)
  })

  it('scopes each concern record to its submission, so a cohort cannot skip its own work', async () => {
    // Inside a batch the run is shared. An unqualified concern key would let the second
    // submission skip 'endpoints' because the first had done it.
    await discover()
    const stages = await query<{ subject_id: string }>(
      `SELECT subject_id FROM run_stage_result WHERE stage = 'discovery.concern' LIMIT 1`)
    expect(stages.rows[0]!.subject_id).toMatch(new RegExp(`^${submissionId}:`))
  })

  it('attributes its spend to the run, which is what a ceiling is enforced against', async () => {
    await discover()
    const run = await query<{ run_id: number }>(
      `SELECT run_id FROM run WHERE kind = 'DISCOVERY'`)
    const spend = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM llm_call_log WHERE run_id = $1`, [run.rows[0]!.run_id])
    expect(spend.rows[0]!.n).toBe(7)
  })

  it('records against a supplied run rather than opening a second one', async () => {
    const ledger = await query<{ run_id: number }>(
      `INSERT INTO run (kind, status, correlation_id, started_by)
       VALUES ('COHORT', 'RUNNING', 'test', $1) RETURNING run_id`, [ACTOR])

    await discover(ledger.rows[0]!.run_id)
    const own = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM run WHERE kind = 'DISCOVERY'`)
    expect(own.rows[0]!.n).toBe(0)
  })

  it('leaves the run FAILED rather than open when it breaks', async () => {
    await query('DELETE FROM scan WHERE submission_id = $1', [submissionId])
    await expect(discover()).rejects.toThrow()
    // The scan precondition fails before a run is opened, so nothing is left dangling.
    const dangling = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM run WHERE kind = 'DISCOVERY' AND status = 'RUNNING'`)
    expect(dangling.rows[0]!.n).toBe(0)
  })
})

describe('resuming (E15-S01)', () => {
  it('does not pay twice for a concern already completed in the run', async () => {
    const first = await discover()
    const runId = (await query<{ ledger_run_id: number }>(
      'SELECT ledger_run_id FROM discovery_run WHERE discovery_id = $1', [first.discoveryId])
    ).rows[0]!.ledger_run_id

    provider.setResponder(discoveryResponder())
    await discover(runId)

    // Every concern was already done in this run, so the second pass made no calls at all.
    expect(provider.requests).toHaveLength(0)
  })
})

describe('the cost ceiling (E15-S03)', () => {
  /**
   * Make each call cost something, so a ceiling can be reached.
   *
   * Priced against the CONFIGURED model rather than the fake provider's name: the gateway
   * resolves the model from `llm_call_config`, and the provider is only the transport. An
   * unpriced model costs zero, and a ceiling over zero is never reached.
   */
  async function priceEachCallAt(perCallUsd: number) {
    // FakeProvider reports 100 tokens in and 50 out.
    await inScope(() => setConfig('llm.model_pricing', {
      'claude-sonnet-5': {
        inputPerMTok: (perCallUsd / 2) * 10_000,
        outputPerMTok: (perCallUsd / 2) * 20_000,
      },
    }, ACTOR))
    invalidateConfig()
  }

  it('PAUSES rather than failing, keeping the concerns already extracted', async () => {
    // The work already done is worth keeping, and an operator who raises the ceiling should
    // resume rather than restart — the same rule every other stage follows.
    await priceEachCallAt(1)
    await inScope(() => setConfig('discovery.cost_ceiling_usd', 2, ACTOR))
    invalidateConfig()

    const outcome = await discover()
    const run = await query<{ status: string; error: string | null }>(
      `SELECT status, error FROM run WHERE kind = 'DISCOVERY'`)

    expect(run.rows[0]!.status).toBe('PAUSED')
    expect(outcome.paused).toMatch(/raise the ceiling and resume/i)

    // What was extracted before the ceiling is kept, not discarded.
    const found = Object.values(outcome.concerns).filter((c) => c.outcome === 'FOUND')
    expect(found.length).toBeGreaterThan(0)
  })

  it('records the concerns it never reached as unattempted, not as unreadable', async () => {
    // An absent concern renders as "could not read", which says we tried. We did not.
    await priceEachCallAt(1)
    await inScope(() => setConfig('discovery.cost_ceiling_usd', 2, ACTOR))
    invalidateConfig()

    const outcome = await discover()
    expect(Object.keys(outcome.concerns)).toHaveLength(7)
    const unattempted = Object.values(outcome.concerns)
      .filter((c) => c.note.includes('Not attempted'))
    expect(unattempted.length).toBeGreaterThan(0)
    expect(unattempted[0]!.note).toMatch(/stopped at its cost ceiling/i)
  })
})

describe('discovery as a batch stage (E15-S02)', () => {
  it('runs BEFORE scoring, because scoring reads what it produces', () => {
    expect([...STAGES]).toEqual(['scan', 'probe', 'discovery', 'score'])
  })
})

describe('coverage over a field (E15-S04)', () => {
  it('reports a field nobody described as consistent rather than as a warning', async () => {
    const coverage = await coverageFor([submissionId, submissionId + 1])
    expect(coverage.state).toBe('NONE')
    expect(coverage.uneven).toBe(false)
  })

  it('flags a field where SOME were described and some were not', async () => {
    await discover()
    const coverage = await coverageFor([submissionId, submissionId + 999])

    expect(coverage.state).toBe('PARTIAL')
    expect(coverage.uneven).toBe(true)
    expect(coverage.note).toMatch(/judged on less context than their competitors/i)
  })

  it('reports a fully described field without a caveat', async () => {
    await discover()
    const coverage = await coverageFor([submissionId])
    expect(coverage.state).toBe('COMPLETE')
    expect(coverage.uneven).toBe(false)
  })

  it('counts a superseded discovery once, not twice', async () => {
    await discover()
    provider.setResponder(discoveryResponder())
    await discover()

    const coverage = await coverageFor([submissionId])
    expect(coverage.discovered).toBe(1)
  })
})
