/**
 * The discovery HTTP surface (E12, P6.x).
 *
 * Contract properties, in the order they matter: nothing discovers implicitly; a description of
 * what a team built is visible to every reviewer; and a submission that has not been discovered
 * says so rather than returning an empty description.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig, setFlag } from '../../src/modules/platform/services/configService.js'
import { resetGateway } from '../../src/modules/llm/services/llmGateway.js'
import { installFakeProvider, restoreProviders, type FakeProvider } from '../support/fakeProvider.js'
import { ACTOR, scanResult, seedCohort, seedScan } from '../support/scoringFixtures.js'
import { DISCOVERY_SOURCE, discoveryResponder } from '../support/discoveryFixtures.js'
import { query } from '../../src/db/pool.js'

let admin: TestUser
let organiser: TestUser
let reviewer: TestUser
let viewer: TestUser
let provider: FakeProvider
let submissionId: number

beforeAll(async () => {
  await resetDatabase()
  installAuditPort()
  invalidateConfig()
  admin = await makeUser('admin')
  organiser = await makeUser('organiser')
  reviewer = await makeUser('reviewer')
  viewer = await makeUser('viewer')
})

afterAll(async () => {
  restoreProviders()
  await closeApp()
})

beforeEach(async () => {
  invalidateConfig()
  resetGateway()
  provider = installFakeProvider()
  provider.setResponder(discoveryResponder())
  await setFlag('feature.discovery.enabled', true, ACTOR)

  const cohort = await seedCohort({ count: 1, files: DISCOVERY_SOURCE })
  submissionId = cohort.submissionIds[0]!
  await query('DELETE FROM scan WHERE submission_id = $1', [submissionId])
  await seedScan(submissionId, scanResult(DISCOVERY_SOURCE))
})

const post = async (user: TestUser) => (await getApp()).inject({
  method: 'POST', url: `/api/v1/submissions/${submissionId}/discovery`, headers: authHeader(user),
})

const get = async (user: TestUser, suffix = '') => (await getApp()).inject({
  method: 'GET', url: `/api/v1/submissions/${submissionId}/discovery${suffix}`,
  headers: authHeader(user),
})

describe('running discovery', () => {
  it('is an organiser action and returns 201 with the per-concern outcomes', async () => {
    const res = await post(organiser)
    expect(res.statusCode).toBe(201)
    const { data } = res.json() as { data: { concerns: Record<string, { outcome: string }> } }
    expect(Object.keys(data.concerns)).toHaveLength(7)
  })

  it('refuses a viewer — seven model calls per submission is a privileged cost', async () => {
    expect((await post(viewer)).statusCode).toBe(403)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await (await getApp()).inject({
      method: 'POST', url: `/api/v1/submissions/${submissionId}/discovery`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('says the feature is off rather than returning an empty description', async () => {
    await setFlag('feature.discovery.enabled', false, ACTOR)
    const res = await post(organiser)
    expect(res.statusCode).toBe(412)
    expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/disabled/i) } })
  })

  it('refuses a submission that has not been scanned', async () => {
    await query('DELETE FROM scan WHERE submission_id = $1', [submissionId])
    expect((await post(organiser)).statusCode).toBe(412)
  })

  it('has no endpoint that discovers as a side effect of scanning', async () => {
    const res = await (await getApp()).inject({
      method: 'POST', url: `/api/v1/submissions/${submissionId}/scan`,
      headers: authHeader(organiser), payload: { force: true },
    })
    // Whatever the scan does, it must not have produced a discovery.
    expect([200, 201, 400, 412, 500]).toContain(res.statusCode)
    const runs = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM discovery_run WHERE submission_id = $1', [submissionId])
    expect(runs.rows[0]!.n).toBe(0)
  })
})

describe('reading a discovery', () => {
  it('is visible to any reviewer — what a team built is not privileged', async () => {
    await post(organiser)
    expect((await get(viewer)).statusCode).toBe(200)
  })

  it('returns the tile strip, the findings and the conflicts in one response', async () => {
    await post(organiser)
    const { data } = (await get(viewer)).json() as {
      data: { tiles: unknown[]; findings: Record<string, unknown[]>; conflicts: unknown[] }
    }
    expect(data.tiles).toHaveLength(7)
    expect(Object.keys(data.findings)).toContain('ENDPOINT')
    expect(data.conflicts).toHaveLength(1)
  })

  it('reports the commit it described, not whatever has been scanned since', async () => {
    await post(organiser)
    const { data } = (await get(viewer)).json() as { data: { commitSha: string; scanId: number } }
    expect(data.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(data.scanId).toBeGreaterThan(0)
  })

  it('404s a submission that has not been discovered, rather than describing nothing', async () => {
    const res = await get(viewer)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({
      error: { message: expect.stringMatching(/has not been discovered/i) },
    })
  })

  it('filters findings by kind', async () => {
    await post(organiser)
    const res = await get(viewer, '/findings?kind=SECURITY')
    const { data } = res.json() as { data: Array<{ kind: string }> }
    expect(data.length).toBeGreaterThan(0)
    expect(data.every((f) => f.kind === 'SECURITY')).toBe(true)
  })

  it('rejects a kind outside the declared vocabulary', async () => {
    await post(organiser)
    expect((await get(viewer, '/findings?kind=EVERYTHING')).statusCode).toBe(400)
  })

  it('serves the conflicts on their own for a page that shows only those', async () => {
    await post(organiser)
    const { data } = (await get(viewer, '/conflicts')).json() as {
      data: Array<{ claim: string; observed: string }>
    }
    expect(data[0]!.observed).toContain('could still be explained by')
  })
})

describe('the concern catalogue', () => {
  it('names the seven concerns so the UI labels them from one declaration (P1.5)', async () => {
    const res = await (await getApp()).inject({
      method: 'GET', url: '/api/v1/discovery/concerns', headers: authHeader(viewer),
    })
    const { data } = res.json() as { data: Array<{ key: string; name: string }> }
    expect(data).toHaveLength(7)
    expect(data.every((c) => c.name.length > 0)).toBe(true)
  })

  it('says for each concern whether an empty result is a real answer', async () => {
    const res = await (await getApp()).inject({
      method: 'GET', url: '/api/v1/discovery/concerns', headers: authHeader(admin),
    })
    const { data } = res.json() as Array<never> & { data: Array<{ key: string; emptyIsMeaningful: boolean }> }
    expect(data.find((c) => c.key === 'integrations')!.emptyIsMeaningful).toBe(true)
    expect(data.find((c) => c.key === 'entities')!.emptyIsMeaningful).toBe(false)
  })
})

describe('setting an observation aside (E16-S03)', () => {
  async function aSecurityFindingId(): Promise<number> {
    await post(organiser)
    const res = await get(viewer, '/findings?kind=SECURITY')
    const { data } = res.json() as { data: Array<{ finding_id: number }> }
    return data[0]!.finding_id
  }

  it('refuses a VIEWER — judging a flagged pattern is a reviewer action', async () => {
    const id = await aSecurityFindingId()
    const res = await (await getApp()).inject({
      method: 'POST', url: `/api/v1/discovery/findings/${id}/dismiss`,
      headers: authHeader(viewer),
      payload: { reason: 'The metric is checked against a fixed list in the caller.' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('accepts a dismissal from a reviewer', async () => {
    const id = await aSecurityFindingId()
    const res = await (await getApp()).inject({
      method: 'POST', url: `/api/v1/discovery/findings/${id}/dismiss`,
      headers: authHeader(reviewer),
      payload: { reason: 'The metric is checked against a fixed list in the caller.' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { dismissed: boolean } }).data.dismissed).toBe(true)
  })

  it('refuses a reason too short to be a reason', async () => {
    const id = await aSecurityFindingId()
    const res = await (await getApp()).inject({
      method: 'POST', url: `/api/v1/discovery/findings/${id}/dismiss`,
      headers: authHeader(reviewer), payload: { reason: 'fine' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('shows the dismissal on the finding rather than hiding it', async () => {
    const id = await aSecurityFindingId()
    await (await getApp()).inject({
      method: 'POST', url: `/api/v1/discovery/findings/${id}/dismiss`,
      headers: authHeader(reviewer),
      payload: { reason: 'A documented test fixture, not a live credential.' },
    })

    const res = await get(viewer, '/findings?kind=SECURITY')
    const { data } = res.json() as {
      data: Array<{ dismissed: boolean; dismissal_reason: string }>
    }
    expect(data[0]!.dismissed).toBe(true)
    expect(data[0]!.dismissal_reason).toMatch(/documented test fixture/)
  })

  it('refuses to reinstate one that is not set aside', async () => {
    const id = await aSecurityFindingId()
    const res = await (await getApp()).inject({
      method: 'POST', url: `/api/v1/discovery/findings/${id}/reinstate`,
      headers: authHeader(reviewer),
    })
    expect(res.statusCode).toBe(404)
  })

  it('audits the dismissal, because it is a decision about evidence', async () => {
    const id = await aSecurityFindingId()
    await (await getApp()).inject({
      method: 'POST', url: `/api/v1/discovery/findings/${id}/dismiss`,
      headers: authHeader(reviewer),
      payload: { reason: 'Checked the caller; the input is validated first.' },
    })

    // Scoped to THIS finding: the database is reset once per file here, so earlier tests in
    // this block have dismissals of their own.
    const audit = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event
        WHERE action = 'discovery.observation_dismissed'
          AND payload->>'findingId' = $1`, [String(id)])
    expect(audit.rows[0]!.n).toBe(1)
  })
})

describe('what changed since the previous discovery (E16-S04)', () => {
  it('is available on demand', async () => {
    await post(organiser)
    const res = await get(viewer, '/changes')
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { comparable: boolean } }).data.comparable).toBe(false)
  })
})
