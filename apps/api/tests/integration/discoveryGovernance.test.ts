/**
 * Discovery as governed evidence (E16).
 *
 * Discovery was reachable from exactly one place: a link on one team's page. It did not appear
 * in the appeal packet — so a team disputing a principles score could not see the map the
 * evaluator was given — nor in the readiness report. And a reviewer who checked a security
 * observation and found it benign had nowhere to record that, so the next reviewer repeated the
 * work and a checked observation looked identical to an unexamined one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { ACTOR, inScope, scanResult, seedCohort, seedScan } from '../support/scoringFixtures.js'
import { DISCOVERY_SOURCE, discoveryResponder } from '../support/discoveryFixtures.js'
import { discoverSubmission } from '../../src/modules/discovery/services/discoveryService.js'
import { discoveryDigest } from '../../src/modules/discovery/services/discoveryDigest.js'
import { diffLatest } from '../../src/modules/discovery/services/discoveryDiff.js'
import { discoveryView } from '../../src/modules/discovery/services/discoveryView.js'
import {
  dismissFinding, reinstateFinding,
} from '../../src/modules/discovery/db/discoveryDb.js'
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

const discover = () => inScope(() => discoverSubmission({ submissionId, actor: ACTOR }))

/**
 * Describe the submission AGAIN at the same commit.
 *
 * An unforced repeat now returns the first description instead of buying a second one, which is
 * the point of the reuse — but comparing one description with the next needs two of them, so
 * these tests ask for the work explicitly.
 */
const rediscover = () => inScope(() => discoverSubmission({
  submissionId, actor: ACTOR, force: true,
}))

async function aSecurityFinding(): Promise<number> {
  const row = await query<{ finding_id: number }>(
    `SELECT finding_id FROM discovery_finding
      WHERE submission_id = $1 AND kind = 'SECURITY' LIMIT 1`, [submissionId])
  return Number(row.rows[0]!.finding_id)
}

describe('setting an observation aside (E16-S03)', () => {
  it('records the dismissal with its reason and who gave it', async () => {
    await discover()
    const findingId = await aSecurityFinding()

    await dismissFinding({
      findingId,
      reason: 'The metric name is checked against a fixed list in the caller.',
      actor: ACTOR,
    })

    const stored = await query<{ reason: string; dismissed_by: string }>(
      'SELECT reason, dismissed_by FROM discovery_dismissal WHERE finding_id = $1', [findingId])
    expect(stored.rows[0]!.dismissed_by).toBe(ACTOR)
    expect(stored.rows[0]!.reason).toMatch(/checked against a fixed list/)
  })

  it('REFUSES a dismissal without a real reason, at the database', async () => {
    // A service check is one the next caller can route around. This is the pattern review_flag
    // already uses, at the level that cannot be worked around.
    await discover()
    const findingId = await aSecurityFinding()

    await expect(
      dismissFinding({ findingId, reason: 'ok', actor: ACTOR }),
    ).rejects.toThrow()
  })

  it('keeps the observation VISIBLE and marked rather than hiding it', async () => {
    // Hiding it would make a checked observation and an unexamined one look identical, which is
    // the confusion the tile design works hardest to avoid everywhere else.
    await discover()
    const findingId = await aSecurityFinding()
    await dismissFinding({ findingId, reason: 'A test fixture, not a live credential.', actor: ACTOR })

    const view = await discoveryView(submissionId)
    const security = view.findings['SECURITY'] as Array<{ dismissed: boolean }>
    expect(security.some((f) => f.dismissed)).toBe(true)
  })

  it('stops the tile warning once nothing is left to check', async () => {
    await discover()
    const before = await discoveryView(submissionId)
    expect(before.tiles.find((t) => t.key === 'security')!.warn).toBe(true)

    const all = await query<{ finding_id: number }>(
      `SELECT finding_id FROM discovery_finding WHERE submission_id = $1 AND kind = 'SECURITY'`,
      [submissionId])
    for (const row of all.rows) {
      await dismissFinding({
        findingId: Number(row.finding_id),
        reason: 'Checked against the caller; the input is validated first.',
        actor: ACTOR,
      })
    }

    const after = await discoveryView(submissionId)
    const tile = after.tiles.find((t) => t.key === 'security')!
    expect(tile.warn).toBe(false)
    // The COUNT does not change: a reviewer checking an observation does not make it stop
    // having existed.
    expect(tile.count).toBe(before.tiles.find((t) => t.key === 'security')!.count)
  })

  it('can be put back, and keeps the withdrawn dismissal', async () => {
    await discover()
    const findingId = await aSecurityFinding()
    await dismissFinding({ findingId, reason: 'Believed to be a fixture value.', actor: ACTOR })

    expect(await reinstateFinding(findingId, ACTOR)).toBe(true)

    const rows = await query<{ withdrawn_at: Date | null }>(
      'SELECT withdrawn_at FROM discovery_dismissal WHERE finding_id = $1', [findingId])
    // Kept, not deleted: reinstating is itself a decision.
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.withdrawn_at).not.toBeNull()
  })

  it('allows only one standing dismissal per finding', async () => {
    await discover()
    const findingId = await aSecurityFinding()
    await dismissFinding({ findingId, reason: 'Checked the caller and it validates.', actor: ACTOR })

    await expect(
      dismissFinding({ findingId, reason: 'Checked it again, still fine.', actor: ACTOR }),
    ).rejects.toThrow()
  })
})

describe('what the evaluators are told about a checked observation (E16-S03)', () => {
  it('marks it as set aside rather than dropping it', async () => {
    // Dropping would hide that anyone looked. Leaving it unmarked would feed an evaluator
    // something a person has already determined is benign, letting it weigh twice.
    await discover()
    const findingId = await aSecurityFinding()
    await dismissFinding({
      findingId, reason: 'The value is a documented test fixture.', actor: ACTOR,
    })

    const digest = await discoveryDigest(submissionId)
    expect(digest).toMatch(/CHECKED BY A REVIEWER AND SET ASIDE/)
    expect(digest).toMatch(/do not weigh this against the submission/)
  })
})

describe('what changed since the previous discovery (E16-S04)', () => {
  it('says there is nothing to compare after a single run', async () => {
    await discover()
    const diff = await diffLatest(submissionId)
    expect(diff.comparable).toBe(false)
    expect(diff.note).toMatch(/nothing to compare it with/i)
  })

  it('reports an identical re-run as unchanged', async () => {
    await discover()
    provider.setResponder(discoveryResponder())
    await rediscover()

    const diff = await diffLatest(submissionId)
    expect(diff.comparable).toBe(true)
    expect(diff.added).toHaveLength(0)
    expect(diff.disappeared).toHaveLength(0)
    expect(diff.note).toMatch(/exactly what the previous one did/i)
  })

  it('names a security observation that is no longer reported', async () => {
    await discover()
    provider.setResponder(discoveryResponder({
      'discovery.security': { observations: [] },
    }))
    await rediscover()

    const diff = await diffLatest(submissionId)
    expect(diff.resolvedSecurity.length).toBeGreaterThan(0)
    expect(diff.disappeared.some((f) => f.kind === 'SECURITY')).toBe(true)
  })

  it('does NOT claim a disappeared finding was fixed', async () => {
    // It may have been fixed, or may simply not have been read this time. The two are
    // indistinguishable from here, and saying "resolved" would invent a conclusion.
    await discover()
    provider.setResponder(discoveryResponder({ 'discovery.security': { observations: [] } }))
    await rediscover()

    // The hedge itself is the property. Asserting the ABSENCE of the word "fixed" would be the
    // wrong shape — the honest sentence contains it, inside the caveat.
    const diff = await diffLatest(submissionId)
    expect(diff.note).toMatch(/may have been fixed, or may simply not have been read/i)
    expect(diff.note).toMatch(/the two look identical from here/i)
  })

  it('is computed on demand, not stored', async () => {
    await discover()
    const tables = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%diff%'`)
    expect(tables.rows[0]!.n).toBe(0)
  })
})
