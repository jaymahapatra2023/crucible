/**
 * Scan persistence and re-scan behaviour (E04-S03, E04-S05).
 *
 * `repo_url` is a local git repository: `git clone` treats a path as a remote, so the real clone
 * path is exercised without depending on a network host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { scanSubmission, persistedScan, hasScan } from '../../src/modules/scans/services/scanService.js'
import { selectProvenance, selectCoverage, selectFlaggedProvenance } from '../../src/modules/scans/db/scanDb.js'
import {
  EVENT_WINDOW, inWindowRepo, makeGitRepo, outOfWindowRepo, type GitRepoFixture,
} from '../support/gitFixtures.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'scan' }, fn)

let repo: GitRepoFixture | null = null
let submissionId: number

async function seedSubmission(repoPath: string, status = 'VALID'): Promise<number> {
  const row = await query<{ submission_id: number }>(
    // A submission belongs to a team (E17-S01), so the fixture creates one rather than
    // relying on a name column that no longer carries identity.
    `WITH t AS (
       INSERT INTO team (display_name, contact_email, origin, created_by)
       VALUES ($1, 'team@test.local', 'ORGANISER', 'fixture') RETURNING team_id
     )
     INSERT INTO submission
       (team_id, team_name, contact_email, challenge_id, repo_url, build_method, build_command,
        validation_status)
     SELECT t.team_id, $1, 'team@test.local', 1, $2, 'COMMAND', 'npm ci', $3 FROM t
     RETURNING submission_id`,
    [`Team ${Math.random().toString(36).slice(2, 8)}`, repoPath, status])
  return row.rows[0]!.submission_id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  repo = makeGitRepo(inWindowRepo())
  submissionId = await seedSubmission(repo.path)
})

afterEach(() => {
  repo?.cleanup()
  repo = null
})

describe('persistence (E04-S05)', () => {
  it('stores the raw result verbatim AND extracts metrics to typed columns (acceptance 1)', async () => {
    const { scan } = await inScope(() => scanSubmission({ submissionId }))

    expect(scan.status).toBe('COMPLETED')
    expect(scan.commit_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(scan.files_analyzed).toBeGreaterThan(0)
    expect(scan.languages).toContain('javascript')
    expect(scan.total_lines).toBeGreaterThan(0)

    const raw = await query<{ raw_result: { files: unknown[]; metrics: unknown } }>(
      'SELECT raw_result FROM scan WHERE scan_id = $1', [scan.scan_id])
    expect(raw.rows[0]!.raw_result.files.length).toBe(scan.files_analyzed)
    expect(raw.rows[0]!.raw_result.metrics).toBeTruthy()
  })

  it('lets scoring read the stored output without re-scanning (acceptance 2)', async () => {
    await inScope(() => scanSubmission({ submissionId }))
    const stored = await persistedScan(submissionId)
    expect(stored.files.length).toBeGreaterThan(0)
    expect(stored.files[0]).toHaveProperty('content')
  })

  it('REFUSES to score a submission that was never scanned — it never scans implicitly', async () => {
    const other = await seedSubmission(repo!.path)
    expect(await hasScan(other)).toBe(false)
    await expect(persistedScan(other)).rejects.toThrow(/never scans implicitly/)
  })

  it('records a content hash, so an identical re-scan is detectable (P7.2)', async () => {
    const { scan } = await inScope(() => scanSubmission({ submissionId }))
    expect(scan.content_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records coverage, so a truncated scan is visible (E04-S04 #2, risk R6)', async () => {
    await inScope(() => scanSubmission({ submissionId }))
    const coverage = await selectCoverage()
    const row = coverage.find((c) => c.submission_id === submissionId)
    expect(row).toBeDefined()
    expect(row!.files_total).toBeGreaterThan(0)
    expect(Number(row!.coverage_pct)).toBeGreaterThan(0)
  })

  it('audits the scan', async () => {
    await inScope(() => scanSubmission({ submissionId }))
    const rows = await query<{ payload: { filesAnalysed: number } }>(
      `SELECT payload FROM audit_event WHERE action = 'scans.scan_completed'`)
    expect(rows.rows[0]!.payload.filesAnalysed).toBeGreaterThan(0)
  })
})

describe('re-scanning the same commit (E04-S03 acceptance 3)', () => {
  it('detects and SKIPS a re-scan at the same commit', async () => {
    const first = await inScope(() => scanSubmission({ submissionId }))
    expect(first.skipped).toBe(false)

    const second = await inScope(() => scanSubmission({ submissionId }))
    expect(second.skipped).toBe(true)
    expect(second.scan.scan_id).toBe(first.scan.scan_id)

    const count = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM scan WHERE submission_id = $1', [submissionId])
    expect(count.rows[0]!.n).toBe(1)
  })

  it('re-scans when forced', async () => {
    const first = await inScope(() => scanSubmission({ submissionId }))
    const forced = await inScope(() => scanSubmission({ submissionId, force: true }))
    expect(forced.skipped).toBe(false)
    expect(forced.scan.scan_id).not.toBe(first.scan.scan_id)
  })

  it('KEEPS the superseded scan as evidence, linked to its replacement (P7.1)', async () => {
    const first = await inScope(() => scanSubmission({ submissionId }))
    const forced = await inScope(() => scanSubmission({ submissionId, force: true }))

    const rows = await query<{ scan_id: number; superseded_at: Date | null; superseded_by: number | null }>(
      'SELECT scan_id, superseded_at, superseded_by FROM scan WHERE submission_id = $1 ORDER BY scan_id',
      [submissionId])

    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]!.scan_id).toBe(first.scan.scan_id)
    expect(rows.rows[0]!.superseded_at).not.toBeNull()
    expect(rows.rows[0]!.superseded_by).toBe(forced.scan.scan_id)
    expect(rows.rows[1]!.superseded_at).toBeNull()
  })

  it('reads the current scan, not a superseded one', async () => {
    await inScope(() => scanSubmission({ submissionId }))
    const forced = await inScope(() => scanSubmission({ submissionId, force: true }))
    const { selectLatestScan } = await import('../../src/modules/scans/db/scanDb.js')
    expect((await selectLatestScan(submissionId))?.scan_id).toBe(forced.scan.scan_id)
  })

  it('scans again when the repository has moved on', async () => {
    await inScope(() => scanSubmission({ submissionId }))

    repo!.cleanup()
    repo = makeGitRepo([...inWindowRepo(), {
      message: 'More work', date: '2026-06-07T18:00:00Z',
      files: { 'src/extra.js': 'export const extra = 1\n' },
    }])
    await query('UPDATE submission SET repo_url = $1 WHERE submission_id = $2',
      [repo.path, submissionId])

    const second = await inScope(() => scanSubmission({ submissionId }))
    expect(second.skipped).toBe(false)
  })

  it('leaves NO temporary working directory behind, on success or on failure (E04-S03 #1)', async () => {
    // With fifty untrusted repositories per run, a leaked clone is a disk-space incident.
    const { readdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const countClones = () =>
      readdirSync(tmpdir()).filter((e) => e.startsWith('crucible-scan-')).length

    const before = countClones()
    await inScope(() => scanSubmission({ submissionId }))
    expect(countClones()).toBe(before)

    const broken = await seedSubmission('/definitely/not/a/repo')
    await expect(inScope(() => scanSubmission({ submissionId: broken }))).rejects.toThrow()
    expect(countClones()).toBe(before)
  })

  it('records a failed scan rather than leaving the submission silently unscanned', async () => {
    const broken = await seedSubmission('/definitely/not/a/repo')
    await expect(inScope(() => scanSubmission({ submissionId: broken }))).rejects.toThrow()

    const failed = await query<{ status: string; error: string }>(
      'SELECT status, error FROM scan WHERE submission_id = $1', [broken])
    expect(failed.rows[0]?.status).toBe('FAILED')
    expect(failed.rows[0]?.error).toBeTruthy()
  })

  it('refuses to scan a submission whose repository did not validate', async () => {
    const invalid = await seedSubmission(repo!.path, 'PRIVATE')
    await expect(inScope(() => scanSubmission({ submissionId: invalid })))
      .rejects.toThrow(/only a repository that validated/i)
  })
})

describe('provenance persistence (E04-S06)', () => {
  it('stores provenance alongside the scan', async () => {
    await query(
      `UPDATE app_config SET value = $1::jsonb WHERE key = 'scans.event_window'`,
      [JSON.stringify(EVENT_WINDOW)])
    invalidateConfig()

    const { scan } = await inScope(() => scanSubmission({ submissionId }))
    const provenance = await selectProvenance(submissionId)

    expect(provenance).not.toBeNull()
    expect(provenance!.scan_id).toBe(scan.scan_id)
    expect(provenance!.total_commits).toBe(3)
    expect(provenance!.commits_in_window).toBe(3)
    expect(provenance!.distinct_authors).toBe(2)
    expect(provenance!.flags).toEqual([])
  })

  it('flags out-of-window work for review WITHOUT excluding anything', async () => {
    await query(
      `UPDATE app_config SET value = $1::jsonb WHERE key = 'scans.event_window'`,
      [JSON.stringify(EVENT_WINDOW)])
    invalidateConfig()

    repo!.cleanup()
    repo = makeGitRepo(outOfWindowRepo())
    const flagged = await seedSubmission(repo.path)
    await inScope(() => scanSubmission({ submissionId: flagged }))

    const provenance = await selectProvenance(flagged)
    expect(provenance!.flags.map((f) => f.code)).toContain('WORK_OUT_OF_WINDOW')

    // The submission itself is untouched — no status change, no exclusion.
    const submission = await query<{ validation_status: string }>(
      'SELECT validation_status FROM submission WHERE submission_id = $1', [flagged])
    expect(submission.rows[0]!.validation_status).toBe('VALID')

    expect((await selectFlaggedProvenance()).some((p) => p.submission_id === flagged)).toBe(true)
  })

  it('records nothing rather than zeroes when there is no history', async () => {
    const { makeRepo } = await import('@crucible/scanner')
    const plain = makeRepo({ 'src/a.js': 'export const a = 1' })
    try {
      // A directory that is not a git repository cannot be cloned, so the scan itself fails —
      // which is the honest outcome for a submission with no repository.
      const noHistory = await seedSubmission(plain.path)
      await expect(inScope(() => scanSubmission({ submissionId: noHistory }))).rejects.toThrow()
      expect(await selectProvenance(noHistory)).toBeNull()
    } finally {
      plain.cleanup()
    }
  })

  it('skips provenance entirely when the flag is off', async () => {
    await query(
      `UPDATE feature_flag SET enabled = FALSE WHERE key = 'feature.scans.provenance'`)
    invalidateConfig()

    await inScope(() => scanSubmission({ submissionId }))
    expect(await selectProvenance(submissionId)).toBeNull()
  })
})
