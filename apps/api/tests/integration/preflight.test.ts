/**
 * Pre-flight checks (E46-S01 … S03).
 *
 * Scan and probe are stubbed at the service boundary exactly as the batch tests stub them: what
 * is under test is the policy around the services — the verdict, UNKNOWN never becoming FAIL,
 * bounded concurrency, the recorded failure of a run that died, and whether the team was told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDatabase } from '../setup/integrationSetup.js'
import { installAuditPort } from '../../src/modules/governance/services/auditService.js'
import {
  invalidateConfig, setConfig, setFlag,
} from '../../src/modules/platform/services/configService.js'
import { registerMailProvider, resetMailProvider, type MailMessage } from '../../src/lib/ports/mailPort.js'
import { preflight, resetPreflightPort } from '../../src/lib/ports/preflightPort.js'
import {
  drainPreflight, enqueuePreflight, failStaleRuns, installPreflightPort, latestPreflight,
  resetPreflightState,
} from '../../src/modules/preflight/services/preflightOrchestrator.js'
import { revalidate } from '../../src/modules/submissions/services/submissionService.js'
import { installFakeGit, restoreGit } from '../support/fakeGit.js'
import { query } from '../../src/db/pool.js'
import { clearSecrets, registerSecrets } from '../../src/lib/redact.js'
import { withCorrelation } from '../../src/lib/correlation.js'
import {
  ACTOR, scannedFile, seedCohort, seedScan, scanResult, type CohortFixture,
} from '../support/scoringFixtures.js'
import type { ScanResult } from '@crucible/scanner'

const inScope = <T>(fn: () => Promise<T>) => withCorrelation({ correlationId: 'preflight' }, fn)

/** Scripted per test: what the probe service reports. Default is a build that ran. */
let probeOutcome: Record<string, unknown> = {}
let probeInFlight = 0
let probeMaxInFlight = 0
const brokenScans = new Set<number>()

vi.mock('../../src/modules/scans/services/scanService.js', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/scans/services/scanService.js')>()
  return {
    ...actual,
    scanSubmission: vi.fn(async (o: { submissionId: number }) => {
      if (brokenScans.has(o.submissionId)) throw new Error('the clone timed out after 60s')
      return { scan: { scan_id: o.submissionId, commit_sha: 'c'.repeat(40) }, skipped: false }
    }),
  }
})

vi.mock('../../src/modules/probes/services/probeService.js', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/probes/services/probeService.js')>()
  return {
    ...actual,
    probeSubmission: vi.fn(async (o: { submissionId: number }) => {
      probeInFlight++
      probeMaxInFlight = Math.max(probeMaxInFlight, probeInFlight)
      await new Promise((r) => setTimeout(r, 30))
      probeInFlight--
      return {
        probe: {
          probe_id: o.submissionId, outcome: 'RUNS', exit_code: 0, stayed_up: true,
          timed_out: false, resource_exceeded: false, probe_error: null, run_duration_ms: 45_000,
          ...probeOutcome,
        },
        skipped: false,
      }
    }),
  }
})

let cohort: CohortFixture
let sent: MailMessage[]

function recordingMail(): void {
  sent = []
  registerMailProvider({
    name: 'recording', sends: true,
    async send(m) { sent.push(m); return { delivered: true, detail: 'ok', providerRef: `ref-${sent.length}` } },
  })
}

const runAll = async () => {
  await inScope(() => drainPreflight())
}

const HISTORY = {
  firstCommitAt: '2026-10-03T13:00:00Z', lastCommitAt: '2026-10-04T10:00:00Z', totalCommits: 12,
  commitsInWindow: 12, commitsOutOfWindow: 0, distinctAuthors: 3, authors: ['a', 'b', 'c'],
  largestSingleCommitPct: 30, historyTruncated: false,
}

/** Sixty lines of real code: enough to clear the substantive-code floor (50). */
const REAL_CODE = scannedFile('src/app.ts',
  Array.from({ length: 60 }, (_, i) => `export function step${i}(x: number) { return x + ${i} }`).join('\n') + '\n')

/** Replace a submission's seeded scan: readable history, a README, and the given files. */
async function reseedScan(submissionId: number, files = [REAL_CODE], hasReadme = true) {
  await query('DELETE FROM scan WHERE submission_id = $1', [submissionId])
  await seedScan(submissionId, scanResult(files, {
    provenance: HISTORY, markers: { hasReadme } as ScanResult['markers'],
  }))
}

const contactOf = async (submissionId: number) => (await query<{ contact_email: string }>(
  'SELECT contact_email FROM team WHERE team_id = (SELECT team_id FROM submission WHERE submission_id = $1)',
  [submissionId])).rows[0]!.contact_email

beforeEach(async () => {
  await resetDatabase()
  invalidateConfig()
  installAuditPort()
  resetPreflightState()
  recordingMail()
  probeOutcome = {}
  probeInFlight = 0
  probeMaxInFlight = 0
  brokenScans.clear()
  cohort = await seedCohort({ count: 1 })
  await reseedScan(cohort.submissionIds[0]!)
})

afterEach(() => {
  resetMailProvider()
  resetPreflightPort()
  restoreGit()
  clearSecrets()
})

describe('a readiness run per submission (E46-S01)', () => {
  it('queues, runs every check through the services, and records READY', async () => {
    const id = cohort.submissionIds[0]!
    const queued = await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    expect(queued.run.status).toBe('QUEUED')
    expect(queued.joined).toBe(false)

    await runAll()

    const view = (await latestPreflight(id))!
    expect(view.run.status).toBe('COMPLETED')
    expect(view.run.verdict).toBe('READY')
    expect(view.run.commitSha).toBe('c'.repeat(40))
    expect(view.run.checks.map((c) => `${c.key}:${c.status}`)).toEqual([
      'scan:PASS', 'provenance:PASS', 'substance:PASS', 'build:PASS', 'run:PASS', 'secrets:PASS',
    ])
    // Discovery is a cost decision, off by default — named as skipped, not silently absent.
    expect(view.run.skipped).toEqual(['discovery'])
  })

  it('records the run in the ledger, one stage per check (acceptance 2)', async () => {
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const run = (await latestPreflight(id))!.run
    const ledger = await query<{ kind: string; status: string }>(
      'SELECT kind, status FROM run WHERE run_id = $1', [run.ledgerRunId])
    expect(ledger.rows[0]).toEqual({ kind: 'PREFLIGHT', status: 'SUCCEEDED' })
    const stages = await query<{ stage: string; outcome: string }>(
      'SELECT stage, outcome FROM run_stage_result WHERE run_id = $1 ORDER BY id', [run.ledgerRunId])
    expect(stages.rows.map((s) => s.stage)).toEqual([
      'preflight.scan', 'preflight.provenance', 'preflight.substance', 'preflight.build', 'preflight.run', 'preflight.secrets',
    ])
  })

  it('renders a harness failure as UNKNOWN, never FAIL (acceptance 3)', async () => {
    probeOutcome = { outcome: 'PROBE_ERROR', probe_error: 'Docker is not running on this host.' }
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const run = (await latestPreflight(id))!.run
    expect(run.verdict).toBe('UNKNOWN')
    const build = run.checks.find((c) => c.key === 'build')!
    expect(build.status).toBe('UNKNOWN')
    expect(build.remedy).toBeNull()
    expect(run.checks.some((c) => c.status === 'FAIL')).toBe(false)
  })

  it('records PROBLEMS with the failing check named and a remedy when the build failed', async () => {
    probeOutcome = { outcome: 'BUILD_FAILED', exit_code: 2, stayed_up: false }
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const run = (await latestPreflight(id))!.run
    expect(run.verdict).toBe('PROBLEMS')
    const build = run.checks.find((c) => c.key === 'build')!
    expect(build.status).toBe('FAIL')
    expect(build.summary).toContain('exit code 2')
    expect(build.remedy).toMatch(/Build it locally/)
    // The run was never attempted, so it is unknown — not a second failure for one cause.
    expect(run.checks.find((c) => c.key === 'run')!.status).toBe('UNKNOWN')
  })

  it('finds a committed credential and names the file, never the value', async () => {
    const id = cohort.submissionIds[0]!
    const secret = 'AKIAIOSFODNN7EXAMPLX'
    await reseedScan(id, [scannedFile('src/config.js', `export const key = '${secret}'\n`)])
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const run = (await latestPreflight(id))!.run
    expect(run.verdict).toBe('PROBLEMS')
    const secrets = run.checks.find((c) => c.key === 'secrets')!
    expect(secrets.status).toBe('FAIL')
    expect(secrets.summary).toContain('src/config.js line 1')
    expect(secrets.remedy).toMatch(/ROTATE/)
    expect(JSON.stringify(run.checks)).not.toContain(secret)
    expect(sent[0]!.body).not.toContain(secret)
  })

  it('fails SUBSTANCE — never refuses — for a repository with no README, naming what to add (E50)', async () => {
    const id = cohort.submissionIds[0]!
    await reseedScan(id, [REAL_CODE], false)
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const run = (await latestPreflight(id))!.run
    expect(run.verdict).toBe('PROBLEMS')
    const substance = run.checks.find((c) => c.key === 'substance')!
    expect(substance.status).toBe('FAIL')
    expect(substance.summary).toMatch(/No README/)
    expect(substance.remedy).toMatch(/Add a README/)
    // And the entry is still VALID: incomplete is not unevaluable.
    const row = await query<{ validation_status: string }>('SELECT validation_status FROM submission WHERE submission_id = $1', [id])
    expect(row.rows[0]!.validation_status).toBe('VALID')
  })

  it('fails SUBSTANCE for a scaffold, saying how many lines it found and needs', async () => {
    const id = cohort.submissionIds[0]!
    await reseedScan(id, [scannedFile('src/index.ts', 'export {}\n')])
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()
    const substance = (await latestPreflight(id))!.run.checks.find((c) => c.key === 'substance')!
    expect(substance.status).toBe('FAIL')
    expect(substance.summary).toMatch(/Only \d+ lines of code .* at least 50/)
  })

  it('is UNKNOWN, not PROBLEMS, when the repository could not be read at scan depth', async () => {
    const id = cohort.submissionIds[0]!
    brokenScans.add(id)
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const run = (await latestPreflight(id))!.run
    expect(run.verdict).toBe('UNKNOWN')
    expect(run.commitSha).toBeNull()
    expect(run.checks.find((c) => c.key === 'scan')!.summary).toMatch(/timed out/)
  })

  it('refuses to queue an entry that has not passed tier 1', async () => {
    const id = cohort.submissionIds[0]!
    await query(`UPDATE submission SET validation_status = 'PRIVATE' WHERE submission_id = $1`, [id])
    await expect(inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR })))
      .rejects.toThrow(/is PRIVATE/)
  })
})

describe('triggered on submission, and by an organiser (E46-S02)', () => {
  it('queues a run through the port when a submission passes tier 1', async () => {
    installPreflightPort()
    installFakeGit()
    const id = cohort.submissionIds[0]!
    await query(`UPDATE submission SET validation_status = 'PENDING' WHERE submission_id = $1`, [id])

    await inScope(() => revalidate(id))

    const view = await latestPreflight(id)
    expect(view?.run.status).toBe('QUEUED')
    expect(view?.run.triggeredBy).toBe('submission')
  })

  it('does not queue again for a re-check that finds the entry still VALID', async () => {
    installPreflightPort()
    installFakeGit()
    const id = cohort.submissionIds[0]!
    await inScope(() => revalidate(id))
    expect(await latestPreflight(id)).toBeNull()
  })

  it('does nothing through the port when automatic runs are switched off', async () => {
    installPreflightPort()
    await setFlag('feature.preflight.auto_run', false, ACTOR)
    invalidateConfig()
    await inScope(() => preflight().enqueue({ submissionId: cohort.submissionIds[0]!, triggeredBy: 'submission' }))
    expect(await latestPreflight(cohort.submissionIds[0]!)).toBeNull()
  })

  it('joins a run already queued rather than starting a second', async () => {
    const id = cohort.submissionIds[0]!
    const first = await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    const second = await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: 'other@test.local' }))
    expect(second.joined).toBe(true)
    expect(second.run.preflightId).toBe(first.run.preflightId)
    const rows = await query('SELECT 1 FROM preflight_run WHERE submission_id = $1', [id])
    expect(rows.rows).toHaveLength(1)
  })

  it('bounds how many run at once by configuration (acceptance 3)', async () => {
    const wide = await seedCohort({ count: 3 })
    for (const id of wide.submissionIds) await reseedScan(id)
    await setConfig('preflight.concurrency', 1, ACTOR)
    invalidateConfig()
    for (const id of wide.submissionIds) {
      await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    }
    await runAll()
    await runAll()
    await runAll()

    expect(probeMaxInFlight).toBe(1)
    for (const id of wide.submissionIds) {
      expect((await latestPreflight(id))?.run.status).toBe('COMPLETED')
    }
  })

  it('leaves a recorded failure, not a submission stuck in "checking", when a run dies (acceptance 5)', async () => {
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await query(`UPDATE preflight_run SET status = 'RUNNING', started_at = now() - interval '2 hours'`)

    const result = await inScope(() => failStaleRuns())
    expect(result.failed).toBe(1)
    const view = (await latestPreflight(id))!
    expect(view.run.status).toBe('FAILED')
    expect(view.run.error).toMatch(/stopped before finishing/)
    // And the team hears "could not be checked", not silence.
    expect(view.notice?.status).toBe('SENT')
    expect(sent[0]!.subject).toMatch(/could not finish checking/)
  })
})

describe('the team is told, either way (E46-S03)', () => {
  it('sends "ready for evaluation" naming the commit, to the team contact', async () => {
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(await contactOf(id))
    expect(sent[0]!.subject).toMatch(/ready for evaluation/)
    expect(sent[0]!.body).toContain('c'.repeat(40))
    expect(sent[0]!.idempotencyKey).toBe(`preflight/${(await latestPreflight(id))!.run.preflightId}`)
    const notice = (await latestPreflight(id))!.notice!
    expect(notice).toMatchObject({ status: 'SENT', mailKey: 'mail.preflight_ready', providerRef: 'ref-1' })
    expect(notice.templateVersion).toBe(1)
  })

  it('names each problem and what to do, and says nothing about a score', async () => {
    probeOutcome = { outcome: 'BUILDS_ONLY', exit_code: 1, stayed_up: false }
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const body = sent[0]!.body
    expect(sent[0]!.subject).toMatch(/things to fix/)
    expect(body).toContain('- Runs: The application exited')
    expect(body).toContain('What to do:')
    // The one mention of a score is the sentence saying there is none.
    expect(body).toContain('This is not a score')
    expect(body.replace('This is not a score', '')).not.toMatch(/score|points|rank/i)
  })

  it('reports UNKNOWN as "could not be checked", distinctly, with an organiser told', async () => {
    probeOutcome = { outcome: 'PROBE_ERROR', probe_error: 'Docker is not running on this host.' }
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const body = sent[0]!.body
    expect(sent[0]!.subject).toMatch(/could not finish checking/)
    expect(body).toContain('- Build: could not be checked — Docker is not running')
    expect(body).toContain('nothing for you to fix')
    expect(body).toMatch(/An organiser has been\s+told/)
    expect(body).not.toMatch(/things to fix/)
  })

  it('does not repeat an identical result, and records that it chose not to', async () => {
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    expect(sent).toHaveLength(1)
    const view = (await latestPreflight(id))!
    expect(view.notice?.status).toBe('UNCHANGED')
    expect(view.notice?.detail).toMatch(/already reported/)
  })

  it('sends a fresh result when the outcome changed', async () => {
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()
    probeOutcome = { outcome: 'BUILD_FAILED', exit_code: 1, stayed_up: false }
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR, force: true }))
    await runAll()

    expect(sent).toHaveLength(2)
    expect(sent[1]!.subject).toMatch(/things to fix/)
  })

  it('records a failure to notify when the team has no contact address (acceptance 6)', async () => {
    const id = cohort.submissionIds[0]!
    await query(`UPDATE team SET contact_email = '' WHERE team_id = (SELECT team_id FROM submission WHERE submission_id = $1)`, [id])
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    expect(sent).toHaveLength(0)
    const notice = (await latestPreflight(id))!.notice!
    expect(notice.status).toBe('FAILED')
    expect(notice.detail).toMatch(/No contact address/)
  })

  it('records a provider failure REDACTED rather than throwing', async () => {
    registerSecrets(['re_live_abcdefghijklmnop123456'])
    registerMailProvider({
      name: 'broken', sends: true,
      async send() { throw new Error('Invalid API key: re_live_abcdefghijklmnop123456') },
    })
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    const view = (await latestPreflight(id))!
    expect(view.run.status).toBe('COMPLETED')
    expect(view.notice?.status).toBe('FAILED')
    expect(view.notice?.detail).not.toContain('re_live_abcdefghijklmnop123456')
  })

  it('records that nobody was told when notification is switched off', async () => {
    await setFlag('feature.preflight.notify', false, ACTOR)
    invalidateConfig()
    const id = cohort.submissionIds[0]!
    await inScope(() => enqueuePreflight({ submissionId: id, triggeredBy: ACTOR }))
    await runAll()

    expect(sent).toHaveLength(0)
    expect((await latestPreflight(id))!.notice?.status).toBe('FAILED')
  })
})
