#!/usr/bin/env node
/**
 * `pnpm db:seed:discovery` — a discovered repository for local development.
 *
 * Unlike `db:seed:cohort`, this does NOT drive the real pipeline: discovery makes seven model
 * calls per submission and a development machine generally has no provider key, so driving it
 * would produce seven FAILED concerns and an empty page. The findings are therefore written
 * directly, and the file says so rather than implying otherwise.
 *
 * What it does preserve is the mix that matters. One concern is genuinely empty, one could not
 * be read at all, and the rest found things. Those three render differently — a count, a real
 * zero, and a stated gap — and that distinction is the whole reason the discovery UI exists.
 *
 * Refuses to run against anything that looks like production.
 */
import { pathToFileURL } from 'node:url'
import { closePool, query, queryOne } from '../pool.js'
import { loadEnv } from '../../config/env.js'
import { CONCERNS, CONFLICT, FINDINGS } from './discoveryFixture.js'

const ACTOR = 'organiser@crucible.local'

async function seedFor(submissionId: number, scanId: number, commitSha: string | null) {
  await query(
    `UPDATE discovery_run SET superseded_at = now()
      WHERE submission_id = $1 AND superseded_at IS NULL`, [submissionId])

  const run = await queryOne<{ discovery_id: number }>(
    `INSERT INTO discovery_run
       (submission_id, scan_id, commit_sha, status, concerns, model, cost_usd,
        started_by, finished_at)
     VALUES ($1, $2, $3, 'COMPLETED', $4::jsonb, 'dev-fixture', $5, $6, now())
     RETURNING discovery_id`,
    [submissionId, scanId, commitSha, JSON.stringify(CONCERNS),
     Object.values(CONCERNS).reduce((sum, c) => sum + c.costUsd, 0), ACTOR])
  if (!run) throw new Error('seedDiscovery: the run was not created')
  const discoveryId = run.discovery_id

  for (const f of FINDINGS) {
    await query(
      `INSERT INTO discovery_finding
         (discovery_id, submission_id, kind, label, summary, detail,
          path, line_start, line_end, excerpt, confidence)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
      [discoveryId, submissionId, f.kind, f.label, f.summary, JSON.stringify(f.detail),
       f.path, f.lineStart, f.lineEnd, f.excerpt, f.confidence])
  }

  await query(
    `INSERT INTO discovery_claim_conflict
       (discovery_id, submission_id, claim, claim_path, claim_line,
        expected, observed, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [discoveryId, submissionId, CONFLICT.claim, CONFLICT.claimPath, CONFLICT.claimLine,
     CONFLICT.expected, CONFLICT.observed, CONFLICT.confidence])

  return discoveryId
}

export async function main(): Promise<void> {
  const env = loadEnv()
  if (env.NODE_ENV === 'production') {
    console.error('\nREFUSED: db:seed:discovery writes fabricated findings and never runs in production.\n')
    process.exit(2)
  }
  if (!/\/crucible(\?|$)/.test(env.DATABASE_URL)) {
    console.error(
      `\nREFUSED: expected the development database 'crucible', got '${env.DATABASE_URL}'.\n`)
    process.exit(2)
  }

  // Discovery describes a SCAN, so it can only be seeded for a submission that has one.
  const scans = await query<{ submission_id: number; scan_id: number; commit_sha: string | null }>(
    `SELECT DISTINCT ON (submission_id) submission_id, scan_id, commit_sha
       FROM scan WHERE status = 'COMPLETED'
      ORDER BY submission_id, scan_id DESC
      LIMIT 3`)

  if (scans.rows.length === 0) {
    console.error(
      '\nNothing to describe: no submission has a completed scan. Run `pnpm db:seed:cohort` first.\n')
    process.exit(1)
  }

  for (const s of scans.rows) {
    const id = await seedFor(Number(s.submission_id), Number(s.scan_id), s.commit_sha)
    console.log(
      `  discovery ${id} for submission ${s.submission_id} — `
      + `${FINDINGS.length} findings, 1 claim conflict, 1 concern not determined`)
  }

  // The feature flag gates RUNNING discovery, not reading it. Turned on so the action is
  // reachable too; with no provider key a run will fail every concern, which is itself the
  // state the page is designed to report honestly.
  await query(`UPDATE feature_flag SET enabled = TRUE WHERE key = 'feature.discovery.enabled'`)

  console.log(
    `\nSeeded. Open /submissions/${scans.rows[0]!.submission_id}/discovery`
    + `\nFindings are fabricated: no provider key is needed to look at the screens.\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch((err: unknown) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(() => closePool())
}
