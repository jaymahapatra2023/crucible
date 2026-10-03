/**
 * Repository discovery against a real database (E12).
 *
 * The model is substituted at the provider boundary, so prompt resolution, schema validation,
 * the retry ladder, persistence, cost accounting and the audit trail all run for real.
 *
 * What these prove is the property the whole feature turns on: a concern that could not be
 * extracted is recorded as a gap, and never as an absence. "0 integrations" and "we could not
 * read the integrations" look identical on a dashboard and mean opposite things.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { ProviderError } from '../../src/modules/llm/providers/providerContract.js'
import { ACTOR, inScope, scanResult, seedCohort, seedScan } from '../support/scoringFixtures.js'
import { DISCOVERY_SOURCE, discoveryResponder } from '../support/discoveryFixtures.js'
import { discoverSubmission } from '../../src/modules/discovery/services/discoveryService.js'
import { discoveryView } from '../../src/modules/discovery/services/discoveryView.js'
import { discoveryDigest, discoveryDigestOrAbsent } from '../../src/modules/discovery/services/discoveryDigest.js'
import { query } from '../../src/db/pool.js'

let provider: FakeProvider
let submissionId: number

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetGateway()
  provider = installFakeProvider()
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

const run = () => inScope(() => discoverSubmission({ submissionId, actor: ACTOR }))

describe('a complete discovery', () => {
  it('records every concern it was asked about', async () => {
    provider.setResponder(discoveryResponder())
    const outcome = await run()

    expect(outcome.status).toBe('COMPLETED')
    expect(Object.keys(outcome.concerns).sort()).toEqual([
      'capabilities', 'claims', 'endpoints', 'entities', 'integrations', 'security', 'stack',
    ])
  })

  it('persists findings with a path and a line range, so each can be checked', async () => {
    provider.setResponder(discoveryResponder())
    await run()

    const rows = await query<{ kind: string; label: string; path: string; line_start: number }>(
      'SELECT kind, label, path, line_start FROM v_discovery_findings WHERE submission_id = $1',
      [submissionId])
    expect(rows.rows.length).toBeGreaterThan(0)
    for (const r of rows.rows) {
      expect(r.path).not.toBe('')
      expect(r.line_start).toBeGreaterThan(0)
    }
  })

  it('records the claim conflict with its innocent explanation attached', async () => {
    provider.setResponder(discoveryResponder())
    await run()

    const rows = await query<{ observed: string }>(
      'SELECT observed FROM discovery_claim_conflict WHERE submission_id = $1', [submissionId])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.observed).toContain('could still be explained by')
  })

  it('attributes its spend to the submission (E10-S03)', async () => {
    provider.setResponder(discoveryResponder())
    await run()

    const cost = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM llm_call_log
        WHERE subject_type = 'submission' AND subject_id = $1 AND call_key LIKE 'discovery.%'`,
      [String(submissionId)])
    expect(cost.rows[0]!.n).toBe(7)
  })

  it('writes an audit event naming every concern outcome', async () => {
    provider.setResponder(discoveryResponder())
    await run()

    const audit = await query<{ payload: { outcomes: Record<string, string> } }>(
      `SELECT payload FROM audit_event WHERE action = 'discovery.completed'`)
    expect(audit.rows).toHaveLength(1)
    expect(Object.keys(audit.rows[0]!.payload.outcomes)).toHaveLength(7)
  })
})

describe('a gap is never an absence (P5.1)', () => {
  it('records a failed concern as FAILED and shows no count for it', async () => {
    provider.setResponder(discoveryResponder({
      'discovery.security': null,
    }))
    // Returning null from the responder falls through to the positional script, which is empty,
    // so the security call fails at the provider — the realistic shape of a timeout.
    const outcome = await run()

    expect(outcome.concerns['security']!.outcome).toBe('FAILED')
    const view = await discoveryView(submissionId)
    const tile = view.tiles.find((t) => t.key === 'security')!
    expect(tile.count).toBeNull()
    expect(tile.warn).toBe(true)
  })

  it('leaves the other six concerns intact when one fails', async () => {
    provider.setResponder(discoveryResponder({ 'discovery.security': null }))
    const outcome = await run()

    expect(outcome.concerns['endpoints']!.outcome).toBe('FOUND')
    expect(outcome.concerns['entities']!.outcome).toBe('FOUND')
    expect(outcome.status).toBe('COMPLETED')
    expect(outcome.usable).toBe(true)
  })

  it('records an extractor that declared insufficient evidence as a gap, not as zero', async () => {
    provider.setResponder(discoveryResponder({
      'discovery.entities': { insufficient_evidence: true, note: 'no migration was read', entities: [] },
    }))
    const outcome = await run()

    expect(outcome.concerns['entities']!.outcome).toBe('INSUFFICIENT_EVIDENCE')
    expect(outcome.concerns['entities']!.note).toBe('no migration was read')
  })

  it('treats an empty entity list as unreadable, because no application stores nothing', async () => {
    provider.setResponder(discoveryResponder({ 'discovery.entities': { entities: [] } }))
    const outcome = await run()
    expect(outcome.concerns['entities']!.outcome).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('treats an empty integration list as a real answer, because an application can have none', async () => {
    provider.setResponder(discoveryResponder({ 'discovery.integrations': { integrations: [] } }))
    const outcome = await run()

    expect(outcome.concerns['integrations']!.outcome).toBe('NONE_FOUND')
    const view = await discoveryView(submissionId)
    expect(view.tiles.find((t) => t.key === 'integrations')!.count).toBe(0)
  })

  it('names every gap on the view, so the page can say what is missing', async () => {
    provider.setResponder(discoveryResponder({ 'discovery.stack': null }))
    await run()

    const view = await discoveryView(submissionId)
    expect(view.gaps.map((g) => g.key)).toContain('stack')
    expect(view.gaps[0]!.note).not.toBe('')
  })
})

describe('re-running supersedes rather than accumulating', () => {
  it('keeps one current run and hides the old findings from the current view', async () => {
    provider.setResponder(discoveryResponder())
    const first = await run()
    provider.setResponder(discoveryResponder())
    const second = await run()

    expect(second.discoveryId).not.toBe(first.discoveryId)
    const current = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM v_discovery_current WHERE submission_id = $1',
      [submissionId])
    expect(current.rows[0]!.n).toBe(1)

    const view = await discoveryView(submissionId)
    expect(view.discoveryId).toBe(second.discoveryId)
  })

  it('keeps the superseded run and its findings as evidence', async () => {
    provider.setResponder(discoveryResponder())
    const first = await run()
    provider.setResponder(discoveryResponder())
    await run()

    const kept = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM discovery_finding WHERE discovery_id = $1',
      [first.discoveryId])
    expect(kept.rows[0]!.n).toBeGreaterThan(0)
  })
})

describe('preconditions', () => {
  it('refuses when the feature is off — seven calls per submission is a chosen cost', async () => {
    await setFlag('feature.discovery.enabled', false, ACTOR)
    await expect(run()).rejects.toThrow(/disabled/i)
  })

  it('refuses a submission that has never been scanned — discovery never clones', async () => {
    await query('DELETE FROM scan WHERE submission_id = $1', [submissionId])
    await expect(run()).rejects.toThrow(/no completed scan/i)
  })
})

describe('what the evaluators are told (ADR 0003)', () => {
  it('gives an evaluator a map of what was found', async () => {
    provider.setResponder(discoveryResponder())
    await run()

    const digest = await discoveryDigest(submissionId)
    expect(digest).toContain('API SURFACE')
    expect(digest).toContain('/api/teams')
    expect(digest).toContain('db/migrations/001_team.sql')
  })

  it('tells the evaluator to cite the source, not the digest', async () => {
    provider.setResponder(discoveryResponder())
    await run()
    expect(await discoveryDigest(submissionId)).toMatch(/not as evidence in itself/i)
  })

  it('passes an unreadable concern as NOT DETERMINED, never as none', async () => {
    provider.setResponder(discoveryResponder({ 'discovery.integrations': null }))
    await run()

    const digest = await discoveryDigest(submissionId)
    expect(digest).toContain('EXTERNAL SYSTEMS: NOT DETERMINED')
    // The instruction that stops an evaluator reading the gap as an absence.
    expect(digest).toMatch(/does NOT mean the repository has none/)
  })

  it('distinguishes a genuinely empty concern from an unreadable one', async () => {
    provider.setResponder(discoveryResponder({ 'discovery.integrations': { integrations: [] } }))
    await run()

    const digest = await discoveryDigest(submissionId)
    expect(digest).toContain('none were found in the files that were read')
    expect(digest).not.toContain('EXTERNAL SYSTEMS: NOT DETERMINED')
  })

  it('says plainly that no discovery was run, rather than rendering a blank section', async () => {
    const digest = await discoveryDigestOrAbsent(submissionId)
    expect(digest).toMatch(/No discovery pass has been run/)
    // And says so in a way that cannot be read as a deficiency in the team's work.
    expect(digest).toMatch(/must not count against it/)
  })

  it('returns nothing at all when discovery was not run, so no section is rendered', async () => {
    expect(await discoveryDigest(submissionId)).toBe('')
  })
})

describe('a run that breaks entirely', () => {
  it('is left recorded as FAILED rather than deleted', async () => {
    provider.setResponder(() => {
      throw new ProviderError('PROVIDER_ERROR', 'the provider is down')
    })
    // Every concern fails, but the run itself completes: a discovery where nothing could be
    // read is a fact about this submission an operator needs to see.
    const outcome = await run()
    expect(outcome.usable).toBe(false)

    const view = await discoveryView(submissionId)
    expect(view.gaps).toHaveLength(7)
    expect(view.tiles.every((t) => t.count === null)).toBe(true)
  })
})
