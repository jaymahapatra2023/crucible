/**
 * Reading the documents a team attached (E36).
 *
 * Most of this is about the boundary. `fetchArtifacts` takes a URL chosen by a competition
 * entrant and fetches it from inside the evaluation network, so the tests that matter are the
 * ones proving it refuses — and refuses in a way that tells an organiser what to change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import {
  registerExtractionPort, resetExtractionPort,
} from '../../src/lib/ports/extractionPort.js'
import { fetchArtifacts } from '../../src/modules/submissions/services/artifactFetch.js'
import { listArtifacts } from '../../src/modules/submissions/db/artifactDb.js'
import { setConfig, invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const ACTOR = 'organiser@test.local'
const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'artifacts' }, fn)

/** An extraction port that reads anything and returns the bytes as text. */
function plainExtractor() {
  registerExtractionPort({
    supports: (mediaType) => mediaType.startsWith('text/'),
    async extract({ buffer }) {
      return { ok: true, text: buffer.toString('utf8'), detail: '' }
    },
  })
}

async function submissionWith(urls: string[]): Promise<number> {
  const challenge = await query<{ challenge_id: number }>(
    `INSERT INTO challenge (name, slug, status, created_by)
     VALUES ('Artifact Challenge', 'artifact-challenge', 'OPEN', 'fixture') RETURNING challenge_id`)
  const team = await query<{ team_id: number }>(
    `INSERT INTO team (display_name, contact_email, origin, created_by)
     VALUES ('Alpha', 'a@b.test', 'ORGANISER', 'fixture') RETURNING team_id`)
  const row = await query<{ submission_id: number }>(
    `INSERT INTO submission
       (team_id, team_name, challenge_id, repo_url, build_method, build_command, contact_email,
        artifact_urls, is_current, submitted_via)
     VALUES ($3, 'Alpha', $1, 'https://github.com/a/b', 'COMMAND', 'npm ci', 'a@b.test',
             $2, TRUE, 'ORGANISER')
     RETURNING submission_id`,
    [challenge.rows[0]!.challenge_id, urls, team.rows[0]!.team_id])
  return Number(row.rows[0]!.submission_id)
}

/** Stand in for the network. Nothing in these tests makes a real request. */
function respondWith(body: string, init: { type?: string; status?: number } = {}) {
  const spy = vi.fn(async () => new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/markdown' },
  }))
  vi.stubGlobal('fetch', spy)
  return spy
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  plainExtractor()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetExtractionPort()
})

describe('the boundary', () => {
  it('REFUSES a host that is not on the allow-list, and names it', async () => {
    const spy = respondWith('should never be requested')
    const id = await submissionWith(['https://evil.example.test/doc.md'])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))

    expect(report.artifacts[0]?.status).toBe('REFUSED')
    expect(report.artifacts[0]?.detail).toMatch(/evil.example.test is not an allowed host/)
    // Named so an organiser can widen the list deliberately.
    expect(report.artifacts[0]?.detail).toMatch(/Allowed: github.com/)
    // And nothing left the process.
    expect(spy).not.toHaveBeenCalled()
  })

  it('REFUSES anything that is not https, including a file:// path', async () => {
    const spy = respondWith('x')
    const id = await submissionWith(['http://github.com/a/b.md', 'file:///etc/passwd'])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))

    expect(report.artifacts.map((a) => a.status)).toEqual(['REFUSED', 'REFUSED'])
    expect(spy).not.toHaveBeenCalled()
  })

  it('REFUSES credentials embedded in the link', async () => {
    const id = await submissionWith(['https://user:pw@github.com/a/b.md'])
    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))
    expect(report.artifacts[0]?.detail).toMatch(/Remove the credentials/)
  })

  it('REFUSES a redirect rather than following it off the allow-list', async () => {
    // The hole an allow-list exists to close: the permitted host hands the request elsewhere.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' },
    })))
    const id = await submissionWith(['https://github.com/a/b.md'])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))
    expect(report.artifacts[0]?.status).toBe('REFUSED')
    expect(report.artifacts[0]?.detail).toMatch(/redirect/)
  })

  it('stops at the byte cap rather than trusting content-length', async () => {
    await setConfig('submissions.artifact_max_bytes', 16, ACTOR)
    invalidateConfig()
    respondWith('x'.repeat(4096))
    const id = await submissionWith(['https://github.com/a/big.md'])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))
    expect(report.artifacts[0]?.status).toBe('TOO_LARGE')
    expect(report.artifacts[0]?.textContent).toBeNull()
  })
})

describe('what it reads', () => {
  it('stores the text of a permitted document', async () => {
    respondWith('# Architecture\n\nWe used an event log because ordering mattered.')
    const id = await submissionWith(['https://github.com/a/arch.md'])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))
    expect(report.artifacts[0]?.status).toBe('FETCHED')
    expect(report.artifacts[0]?.textContent).toMatch(/event log because ordering mattered/)
  })

  it('truncates a long document and SAYS it truncated', async () => {
    await setConfig('submissions.artifact_max_chars', 20, ACTOR)
    invalidateConfig()
    respondWith('y'.repeat(500))
    const id = await submissionWith(['https://github.com/a/long.md'])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))
    expect(report.artifacts[0]?.textContent).toHaveLength(20)
    // A reader judging from a truncated document has to know that is what they are doing.
    expect(report.artifacts[0]?.detail).toMatch(/Read the first 20 characters of 500/)
  })

  it('records a type nothing can read as UNSUPPORTED_TYPE, not a failure', async () => {
    respondWith('binary', { type: 'application/zip' })
    const id = await submissionWith(['https://github.com/a/thing.zip'])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))
    expect(report.artifacts[0]?.status).toBe('UNSUPPORTED_TYPE')
    expect(report.artifacts[0]?.detail).toMatch(/Attach a PDF/)
  })

  it('reads the good link when another one is dead', async () => {
    // Failing the whole operation would throw away evidence because of the link that had none.
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response(null, { status: 404 })
        : new Response('good content', { headers: { 'content-type': 'text/markdown' } })
    }))
    const id = await submissionWith([
      'https://github.com/a/dead.md', 'https://github.com/a/good.md',
    ])

    const report = await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))
    expect(report.artifacts.map((a) => a.status)).toEqual(['UNREACHABLE', 'FETCHED'])
  })

  it('replaces the record on a re-fetch rather than accumulating attempts', async () => {
    respondWith('first')
    const id = await submissionWith(['https://github.com/a/doc.md'])
    await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))

    respondWith('second')
    await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))

    const stored = await listArtifacts(id)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.textContent).toBe('second')
  })
})

describe('the audit trail', () => {
  it('records counts by outcome, not the links themselves', async () => {
    respondWith('content')
    const id = await submissionWith(['https://github.com/a/private-doc.md'])
    await inScope(() => fetchArtifacts({ submissionId: id, actor: ACTOR }))

    const audit = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_event WHERE action = 'submissions.artifacts_fetched'`)
    expect(audit.rows[0]?.payload).toMatchObject({ total: 1, fetched: 1, refused: 0 })
    expect(JSON.stringify(audit.rows[0])).not.toContain('private-doc')
  })
})
