/**
 * What gets evaluated is the locked commit, not HEAD (E50 review; E03-S04's promise).
 *
 * The receipt tells a team "this exact commit is what will be evaluated". Until this review the
 * scan cloned the default branch's HEAD on the night, so a push after the deadline would have
 * been judged. A real repository, two commits, the first one locked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import { invalidateConfig } from '../../src/modules/platform/services/configService.js'
import { scanSubmission } from '../../src/modules/scans/services/scanService.js'
import { makeGitRepo, inWindowRepo, type GitRepoFixture } from '../support/gitFixtures.js'
import { seedSubmission, seedCohort } from '../support/scoringFixtures.js'
import { query } from '../../src/db/pool.js'
import { withCorrelation } from '../../src/lib/correlation.js'

const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'locked' }, fn)
let repo: GitRepoFixture | null = null

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
})
afterEach(() => { repo?.cleanup(); repo = null })

describe('scanning after the lock', () => {
  it('reads the locked commit even though HEAD has moved on', async () => {
    repo = makeGitRepo(inWindowRepo())
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo!.path, encoding: 'utf8' }).trim()
    const locked = git(['rev-parse', 'HEAD'])
    mkdirSync(join(repo.path, 'src'), { recursive: true })
    writeFileSync(join(repo.path, 'src/after-deadline.ts'), 'export const late = true\n')
    git(['add', '-A']); git(['commit', '--quiet', '-m', 'pushed after the deadline'])
    const head = git(['rev-parse', 'HEAD'])
    expect(head).not.toBe(locked)

    const cohort = await seedCohort({ count: 0 })
    const submissionId = await seedSubmission(cohort.challengeId)
    await query('UPDATE submission SET repo_url = $2, locked_commit_sha = $3 WHERE submission_id = $1',
      [submissionId, `file://${repo.path}`, locked])

    const outcome = await inScope(() => scanSubmission({ submissionId, actor: 'test' }))
    expect(outcome.scan.commit_sha).toBe(locked)
    const files = await query<{ raw_result: { files: Array<{ path: string }> } }>(
      'SELECT raw_result FROM scan WHERE scan_id = $1', [outcome.scan.scan_id])
    expect(files.rows[0]!.raw_result.files.map((f) => f.path)).not.toContain('src/after-deadline.ts')
  })

  it('reads HEAD before the lock, which is what pre-flight should see', async () => {
    repo = makeGitRepo(inWindowRepo())
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8' }).trim()
    const cohort = await seedCohort({ count: 0 })
    const submissionId = await seedSubmission(cohort.challengeId)
    await query('UPDATE submission SET repo_url = $2, locked_commit_sha = NULL WHERE submission_id = $1',
      [submissionId, `file://${repo.path}`])
    const outcome = await inScope(() => scanSubmission({ submissionId, actor: 'test' }))
    expect(outcome.scan.commit_sha).toBe(head)
  })
})
