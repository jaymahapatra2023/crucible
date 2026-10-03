/**
 * Challenge intake contract tests (E02-S01, E02-S02).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { authHeader, closeApp, getApp, makeUser, type TestUser } from '../support/testServer.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { makeDocx, makeEmptyPdf, makePdf } from '../support/documentFixtures.js'
import { query } from '../../src/db/pool.js'
import type { FastifyInstance } from 'fastify'

let organiser: TestUser
let viewer: TestUser
let app: FastifyInstance

const BRIEF_MD = [
  '# Challenge Alpha', '', 'Build a telemetry pipeline.', '',
  '## 2.1 Ingestion', '', 'Consume the provided feed.', '',
  '## 3.2 Detection', '', 'Raise an alert on threshold breach.',
].join('\n')

/** Build a multipart body by hand — deterministic and dependency-free. */
function multipart(filename: string, content: Buffer, mediaType: string, kind = 'BRIEF') {
  const boundary = '----CrucibleTestBoundary1234567890'
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

async function newChallenge(name = 'Challenge Alpha'): Promise<number> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/challenges',
    headers: authHeader(organiser), payload: { name },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { data: { challengeId: number } }).data.challengeId
}

async function upload(id: number, filename: string, content: Buffer, mediaType: string, kind = 'BRIEF') {
  const mp = multipart(filename, content, mediaType, kind)
  return app.inject({
    method: 'POST', url: `/api/v1/challenges/${id}/artifacts`,
    headers: { ...authHeader(organiser), ...mp.headers },
    payload: mp.payload,
  })
}

beforeAll(async () => {
  app = await getApp()
  installAuditPort()
})
beforeEach(async () => {
  await resetDatabase()
  organiser = await makeUser('organiser')
  viewer = await makeUser('viewer')
})
afterAll(async () => closeApp())

describe('challenge lifecycle (E02-S01)', () => {
  it('creates a challenge with a derived slug', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/challenges',
      headers: authHeader(organiser), payload: { name: 'Real-Time Telemetry!' },
    })
    expect(res.statusCode).toBe(201)
    const c = (res.json() as { data: { slug: string; status: string } }).data
    expect(c.slug).toBe('real-time-telemetry')
    expect(c.status).toBe('DRAFT')
  })

  it('refuses a duplicate slug', async () => {
    await newChallenge()
    const res = await app.inject({
      method: 'POST', url: '/api/v1/challenges',
      headers: authHeader(organiser), payload: { name: 'Challenge Alpha' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('lists challenges with a real backend total', async () => {
    await newChallenge('One'); await newChallenge('Two'); await newChallenge('Three')
    const res = await app.inject({
      method: 'GET', url: '/api/v1/challenges?pageSize=2', headers: authHeader(viewer),
    })
    const body = res.json() as { data: unknown[]; meta: { total: number } }
    expect(body.data).toHaveLength(2)
    expect(body.meta.total).toBe(3)
  })

  it('soft-deletes a DRAFT challenge and hides it from listings', async () => {
    const id = await newChallenge()
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/challenges/${id}`, headers: authHeader(organiser),
    })
    expect(del.statusCode).toBe(204)

    const get = await app.inject({
      method: 'GET', url: `/api/v1/challenges/${id}`, headers: authHeader(viewer),
    })
    expect(get.statusCode).toBe(404)

    // P7.4: the row is retained with a reason, not destroyed.
    const rows = await query<{ delete_reason: string }>(
      'SELECT delete_reason FROM challenge WHERE challenge_id = $1', [id])
    expect(rows.rows[0]?.delete_reason).toBe('ADMIN_ACTION')
  })

  it('refuses to delete a challenge that is no longer DRAFT', async () => {
    const id = await newChallenge()
    await app.inject({
      method: 'PATCH', url: `/api/v1/challenges/${id}/status`,
      headers: authHeader(organiser), payload: { status: 'OPEN' },
    })
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/challenges/${id}`, headers: authHeader(organiser),
    })
    expect(del.statusCode).toBe(409)
    expect((del.json() as { error: { message: string } }).error.message).toMatch(/only a draft/i)
  })

  it('requires organiser to create; a viewer is refused', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/challenges',
      headers: authHeader(viewer), payload: { name: 'Sneaky' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('artifact upload (E02-S01 acceptance 1, 2)', () => {
  it('accepts Markdown and extracts it immediately', async () => {
    const id = await newChallenge()
    const res = await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')
    expect(res.statusCode).toBe(201)
    const a = (res.json() as { data: { extractionStatus: string; extractedSections: unknown[] } }).data
    expect(a.extractionStatus).toBe('EXTRACTED')
    expect(a.extractedSections.length).toBeGreaterThanOrEqual(3)
  })

  it('accepts PDF', async () => {
    const id = await newChallenge()
    const res = await upload(id, 'brief.pdf', makePdf(['Build a telemetry pipeline.']), 'application/pdf')
    expect(res.statusCode).toBe(201)
    expect((res.json() as { data: { extractionStatus: string } }).data.extractionStatus).toBe('EXTRACTED')
  })

  it('accepts DOCX', async () => {
    const id = await newChallenge()
    const docx = makeDocx([{ heading: 1, text: 'Challenge Alpha' }, { text: 'Build the pipeline.' }])
    const res = await upload(id, 'brief.docx', docx,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(res.statusCode).toBe(201)
    expect((res.json() as { data: { extractionStatus: string } }).data.extractionStatus).toBe('EXTRACTED')
  })

  it('accepts several artifacts on one challenge', async () => {
    const id = await newChallenge()
    await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')
    await upload(id, 'rules.md', Buffer.from('# Rules\n\nSubmit by Friday.'), 'text/markdown', 'RULES')
    const res = await app.inject({
      method: 'GET', url: `/api/v1/challenges/${id}/artifacts`, headers: authHeader(viewer),
    })
    expect((res.json() as { data: unknown[] }).data).toHaveLength(2)
  })

  it('rejects an unsupported format naming what is accepted', async () => {
    const id = await newChallenge()
    const res = await upload(id, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    expect(res.statusCode).toBe(415)
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/\.pdf/)
  })

  it('names the limit and the file when a upload is too large (acceptance 2)', async () => {
    const id = await newChallenge()
    await query(`UPDATE app_config SET value = '1024'::jsonb WHERE key = 'platform.max_upload_bytes'`)
    const { invalidateConfig } = await import('../../src/modules/platform/services/configService.js')
    invalidateConfig()

    const res = await upload(id, 'huge-brief.md', Buffer.alloc(5000, 'x'), 'text/markdown')
    expect(res.statusCode).toBe(413)
    const message = (res.json() as { error: { message: string } }).error.message
    expect(message).toMatch(/huge-brief\.md/)
    expect(message).toMatch(/KB|MB|limit/)
    invalidateConfig()
  })

  it('rejects an empty file', async () => {
    const id = await newChallenge()
    const res = await upload(id, 'empty.md', Buffer.alloc(0), 'text/markdown')
    expect(res.statusCode).toBe(400)
  })

  it('rejects identical content uploaded twice', async () => {
    const id = await newChallenge()
    await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')
    const res = await upload(id, 'brief-copy.md', Buffer.from(BRIEF_MD), 'text/markdown')
    expect(res.statusCode).toBe(409)
  })

  it('refuses artifacts once the challenge is no longer DRAFT', async () => {
    const id = await newChallenge()
    await app.inject({
      method: 'PATCH', url: `/api/v1/challenges/${id}/status`,
      headers: authHeader(organiser), payload: { status: 'OPEN' },
    })
    const res = await upload(id, 'late.md', Buffer.from('# Late'), 'text/markdown')
    expect(res.statusCode).toBe(409)
  })
})

describe('retention and re-download (E02-S01 acceptance 3)', () => {
  it('returns the original bytes, unchanged', async () => {
    const id = await newChallenge()
    const uploaded = await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')
    const artifactId = (uploaded.json() as { data: { artifactId: number } }).data.artifactId

    const res = await app.inject({
      method: 'GET', url: `/api/v1/challenges/${id}/artifacts/${artifactId}/content`,
      headers: authHeader(viewer),
    })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.toString('utf8')).toBe(BRIEF_MD)
    expect(res.headers['content-disposition']).toMatch(/brief\.md/)
  })

  it('audits the download', async () => {
    const id = await newChallenge()
    const uploaded = await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')
    const artifactId = (uploaded.json() as { data: { artifactId: number } }).data.artifactId
    await app.inject({
      method: 'GET', url: `/api/v1/challenges/${id}/artifacts/${artifactId}/content`,
      headers: authHeader(viewer),
    })
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_event WHERE action = 'challenge.artifact_downloaded'`)
    expect(rows.rows[0]!.n).toBe(1)
  })
})

describe('extraction failures are per-file (E02-S02 acceptance 2)', () => {
  it('records a failure without failing the upload or the other artifacts', async () => {
    const id = await newChallenge()
    await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')

    // A scanned PDF: valid file, no extractable text.
    const scan = await upload(id, 'scan.pdf', makeEmptyPdf(), 'application/pdf')
    expect(scan.statusCode).toBe(201)
    expect((scan.json() as { data: { extractionStatus: string; extractionError: string } }).data)
      .toMatchObject({ extractionStatus: 'FAILED' })

    const health = await app.inject({
      method: 'GET', url: `/api/v1/challenges/${id}/extraction-health`, headers: authHeader(viewer),
    })
    expect((health.json() as { data: { artifacts: number; extracted: number; failed: number } }).data)
      .toMatchObject({ artifacts: 2, extracted: 1, failed: 1 })
  })

  it('surfaces the reason, so an organiser can act on it', async () => {
    const id = await newChallenge()
    const res = await upload(id, 'scan.pdf', makeEmptyPdf(), 'application/pdf')
    const err = (res.json() as { data: { extractionError: string } }).data.extractionError
    expect(err).toMatch(/scan|no extractable text/i)
  })

  it('re-extraction can be triggered and is idempotent (acceptance 3)', async () => {
    const id = await newChallenge()
    await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')

    const res = await app.inject({
      method: 'POST', url: `/api/v1/challenges/${id}/extract`, headers: authHeader(organiser),
    })
    expect(res.statusCode).toBe(200)
    const outcomes = (res.json() as { data: Array<{ status: string }> }).data
    expect(outcomes.every((o) => o.status === 'EXTRACTED')).toBe(true)
  })

  it('persists extracted text so generation never re-parses (acceptance 3)', async () => {
    const id = await newChallenge()
    await upload(id, 'brief.md', Buffer.from(BRIEF_MD), 'text/markdown')
    const rows = await query<{ extracted_text: string; extracted_sections: unknown[] }>(
      'SELECT extracted_text, extracted_sections FROM challenge_artifact WHERE challenge_id = $1', [id])
    expect(rows.rows[0]?.extracted_text).toContain('Consume the provided feed.')
    expect(rows.rows[0]?.extracted_sections.length).toBeGreaterThan(0)
  })
})

describe('the public challenge list (P8.1)', () => {
  it('is readable without a session — a team has no account by design', async () => {
    const res = await (await getApp()).inject({ method: 'GET', url: '/api/v1/challenges/open' })
    expect(res.statusCode).toBe(200)
  })

  it('lists only OPEN challenges, so a draft is not disclosed', async () => {
    const app = await getApp()
    const draft = await app.inject({
      method: 'POST', url: '/api/v1/challenges', headers: authHeader(organiser),
      payload: { name: 'Still being written', description: '' },
    })
    const draftId = (draft.json() as { data: { challengeId: number } }).data.challengeId

    const open = await app.inject({
      method: 'POST', url: '/api/v1/challenges', headers: authHeader(organiser),
      payload: { name: 'Open for entries', description: '' },
    })
    const openId = (open.json() as { data: { challengeId: number } }).data.challengeId
    await app.inject({
      method: 'PATCH', url: `/api/v1/challenges/${openId}/status`,
      headers: authHeader(organiser), payload: { status: 'OPEN' },
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/challenges/open' })
    const ids = (res.json() as { data: Array<{ challengeId: number }> }).data
      .map((c) => c.challengeId)
    expect(ids).toContain(openId)
    expect(ids).not.toContain(draftId)
  })

  it('carries nothing beyond an id and a name', async () => {
    const res = await (await getApp()).inject({ method: 'GET', url: '/api/v1/challenges/open' })
    for (const row of (res.json() as { data: Array<Record<string, unknown>> }).data) {
      expect(Object.keys(row).sort()).toEqual(['challengeId', 'name'])
    }
  })
})
