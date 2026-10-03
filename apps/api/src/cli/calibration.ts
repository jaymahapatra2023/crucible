#!/usr/bin/env node
/**
 * `pnpm calibration <command>` — run the go/no-go gate from a terminal.
 *
 * The gate is the control P0 says must pass before this system ranks anything, and until now it
 * could only be reached through the web application. That is the wrong shape for the job: a
 * golden set is a dozen repositories described in a file, built once, and the committee's two
 * rankings arrive as two files from two people who never saw each other's.
 *
 * Every command goes through the same services the web application calls. Nothing here reaches
 * into the database to do something the product cannot do — that is precisely the mistake that
 * hid the missing entry-to-submission link for so long.
 */
import { readFile } from 'node:fs/promises'
import { closePool, query } from '../db/pool.js'
import { withCorrelation } from '../lib/correlation.js'
import { installAuditPort } from '../modules/governance/services/auditService.js'
import { parseCsv, headerIndex } from '../lib/csv.js'
import { createGoldenSet, addEntry } from '../modules/calibration/services/goldenSetService.js'
import { linkGoldenSet } from '../modules/calibration/services/goldenSetLink.js'
import { createTeam } from '../modules/submissions/services/teamService.js'
import { submit } from '../modules/submissions/services/submissionService.js'
import { runBatch } from '../modules/batch/services/batchOrchestrator.js'
import { heading, line, parseArgs, run, table, UsageError, type Args } from './args.js'
import {
  criteriaCommand, decideCommand, rankCommand, readinessCommand, reportCommand, sealCommand,
} from './calibrationGate.js'
import { compareCommand, holisticCommand } from './holisticCommands.js'

const USAGE = `pnpm calibration <command> [flags]

  status                        every golden set, what it is waiting for, and its latest verdict
  bootstrap --file <csv>        build a set from a file of repositories, enter and link them
            --challenge <id> --actor <email> [--name <text>] [--set <id>]
  score     --set <id> --run 1|2 --actor <email> [--cohort <key>] [--discovery]
            [--resume <batchRunId>]  continue a paused run without redoing its work
            scan, probe and score the whole set, as a real entry would be
  link      --set <id> --actor <email> [--confirm] [--challenge <id>]
  rank      --set <id> --ranker <email> --file <ordering.txt>
  readiness --set <id>
  seal      --set <id> --actor <email>
  criteria  --set <id> --actor <email> --fallback "<plan>"
            [--min-rho 0.7] [--max-disagreements 2] [--rank-gap 3] [--max-variance 10]
  holistic  --set <id> --pass 1|2 --actor <email>
            evaluate the whole set with ONE call per repository and no criteria (experiment)
  compare   --set <id> --cohort <key>
            both approaches side by side, each correlated against the hand ranking
  report    --set <id> --run <runIndexId> --actor <email> [--cohort <key>]
  decide    --report <id> --decision GO|NO_GO --rationale "<why>" --actor <email>

The repository file is CSV with a header naming label, repo_url, band and edge_case.
build_method, build_command and dockerfile_path are optional and default to a Dockerfile.

  label,repo_url,band,edge_case,build_method,build_command
  Angular RealWorld,https://github.com/realworld-apps/angular-realworld-example-app,STRONG,,COMMAND,npm ci && npm run build`

const COLUMNS = {
  label: ['label', 'name', 'entry'],
  repo_url: ['repo_url', 'repo', 'repository', 'url'],
  band: ['band', 'expected_band'],
  edge_case: ['edge_case', 'edge', 'edgecase'],
} as const

const go = <T>(fn: () => Promise<T>) =>
  withCorrelation({ correlationId: 'cli-calibration' }, fn)

/** Where every set has got to, so the next command is obvious rather than remembered. */
async function statusCommand(): Promise<void> {
  const sets = await query<{
    golden_set_id: number; name: string; status: string
    entries: number; linked: number; rankers: number
    report_id: number | null; rho: string | null; decision: string | null
  }>(
    `SELECT g.golden_set_id, g.name, g.status,
            (SELECT COUNT(*)::int FROM golden_entry e WHERE e.golden_set_id = g.golden_set_id)
              AS entries,
            (SELECT COUNT(*)::int FROM golden_entry e
              WHERE e.golden_set_id = g.golden_set_id AND e.submission_id IS NOT NULL) AS linked,
            (SELECT COUNT(DISTINCT r.ranker)::int FROM golden_ranking r
              WHERE r.golden_set_id = g.golden_set_id) AS rankers,
            rep.report_id, rep.rank_correlation::text AS rho, d.decision
       FROM golden_set g
       LEFT JOIN LATERAL (
         SELECT report_id, rank_correlation FROM calibration_report c
          WHERE c.golden_set_id = g.golden_set_id ORDER BY report_id DESC LIMIT 1
       ) rep ON TRUE
       LEFT JOIN gate_decision d ON d.report_id = rep.report_id
      ORDER BY g.golden_set_id`)

  heading('Golden sets')
  if (sets.rows.length === 0) {
    line('None. Build one with:  pnpm calibration bootstrap --file <csv> --challenge <id> …')
    return
  }
  table(
    ['id', 'name', 'status', 'entries', 'linked', 'rankers', 'rho', 'decision', 'next'],
    sets.rows.map((s) => [
      String(s.golden_set_id), s.name.slice(0, 28), s.status,
      String(s.entries), String(s.linked), String(s.rankers),
      s.rho ?? '—', s.decision ?? '—', nextStep(s),
    ]))

  const runs = await query<{ run_index_id: number; cohort_key: string; run_index: number }>(
    `SELECT run_index_id, cohort_key, run_index FROM score_run
      ORDER BY run_index_id DESC LIMIT 8`)
  heading('Recent score runs — a report compares against one of these')
  table(['run', 'cohort', 'index'], runs.rows.map((r) => [
    String(r.run_index_id), r.cohort_key, String(r.run_index),
  ]))
}

function nextStep(s: {
  status: string; entries: number; linked: number; rankers: number
  report_id: number | null; decision: string | null
}): string {
  if (s.entries === 0) return 'bootstrap'
  if (s.linked < s.entries) return 'link'
  if (s.rankers < 2) return 'rank'
  if (s.status !== 'SEALED') return 'seal'
  if (s.report_id === null) return 'criteria, then report'
  if (s.decision === null) return 'decide'
  return 'done'
}

/**
 * Build a set from a file, enter each repository, and link them.
 *
 * The repositories are entered through the ordinary on-behalf path so that they are scanned,
 * probed and scored by exactly the code a real entry meets. A golden set scored by a shortcut
 * would calibrate the shortcut.
 */
async function bootstrapCommand(args: Args): Promise<void> {
  const file = args.require('file', 'a CSV of repositories. See the usage above.')
  const challengeId = args.number('challenge', 0)
  if (challengeId === 0) {
    throw new UsageError('--challenge is required: the challenge whose rubric these are judged by.')
  }
  const actor = args.require('actor', 'who is building the set; this is recorded.')

  const rows = readRepoFile(await readFile(file, 'utf8'))
  line(`${rows.length} repositories read from ${file}.`)

  const setId = args.number('set', 0) || Number((await go(() => createGoldenSet({
    name: args.flag('name') ?? `Golden set from ${file}`,
    description: `Built from ${file}.`,
    actor,
  }))).golden_set_id)
  line(`Golden set ${setId}.`)

  for (const row of rows) {
    await go(() => addEntry({
      goldenSetId: setId, label: row.label, repoUrl: row.repoUrl,
      expectedBand: row.band, edgeCase: row.edgeCase, notes: `from ${file}`, actor,
    }))

    // A team per repository, because a submission belongs to one (E17-S01). These are not
    // people; they are the entries the committee ranked, entered on their behalf.
    const team = await go(() => createTeam({
      displayName: row.label, contactEmail: `${slug(row.label)}@golden.invalid`,
      origin: 'ORGANISER', actor,
    }))
    await go(() => submit({
      teamId: team.teamId, contactEmail: team.contactEmail, challengeId,
      repoUrl: row.repoUrl, buildMethod: row.buildMethod,
      ...(row.buildCommand !== null && { buildCommand: row.buildCommand }),
      ...(row.dockerfilePath !== null && { dockerfilePath: row.dockerfilePath }),
      via: 'ORGANISER', submittedTokenId: null, actor,
    }))
    line(`  entered ${row.label}`)
  }

  const plan = await go(() => linkGoldenSet({
    goldenSetId: setId, challengeId, confirm: true, actor,
  }))
  line('')
  line(`Linked ${plan.summary.resolved} of ${plan.summary.total}.`)
  if (plan.refusal) line(plan.refusal)
  line('')
  line(`Next:  pnpm calibration score --set ${setId} --run 1 --actor ${actor}`)
}

async function linkCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required.')
  const actor = args.require('actor', 'who is linking; this is recorded.')

  const plan = await go(() => linkGoldenSet({
    goldenSetId: setId, confirm: args.has('confirm'), actor,
    ...(args.number('challenge', 0) !== 0 && { challengeId: args.number('challenge', 0) }),
  }))

  heading(args.has('confirm') ? 'Linked' : 'What linking would do')
  table(['entry', 'submission', 'state', 'detail'], plan.rows.map((r) => [
    r.label, r.submissionId === null ? '—' : `#${r.submissionId}`,
    r.outcome.toLowerCase(), (r.detail ?? '').slice(0, 70),
  ]))
  line('')
  line(`${plan.summary.resolved} of ${plan.summary.total} resolved.`)
  if (plan.refusal) line(plan.refusal)
  if (!args.has('confirm') && plan.summary.unresolved === 0) {
    line('Nothing was written. Add --confirm to record it.')
  }
}

/**
 * Put the whole set through the pipeline an entry meets: scan, probe, score, rank.
 *
 * The batch rather than the scorer alone. Scoring reads a scan and a probe, so calling the
 * scorer directly against repositories nothing had cloned would produce a cohort of non-scores
 * and call it a run — and calibrating against that would measure the absence of evidence.
 */
async function scoreCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required.')
  const runIndex = args.number('run', 0)
  if (runIndex !== 1 && runIndex !== 2) {
    throw new UsageError('--run must be 1 or 2. Both exist so the pair can be compared (E06-S06).')
  }
  const actor = args.require('actor', 'who started it; this is recorded.')
  const cohortKey = args.flag('cohort') ?? `golden-set-${setId}`

  const linked = await query<{ submission_id: number; challenge_id: number }>(
    `SELECT e.submission_id, s.challenge_id
       FROM golden_entry e
       JOIN v_submissions_submission s ON s.submission_id = e.submission_id
      WHERE e.golden_set_id = $1 AND e.submission_id IS NOT NULL`, [setId])
  if (linked.rows.length === 0) {
    throw new UsageError(
      `No entry in set ${setId} is linked to a submission that validated. Run \`link\` to see `
      + `what is unresolved — without it there is nothing for a report to compare against.`)
  }

  const challengeIds = [...new Set(linked.rows.map((r) => Number(r.challenge_id)))]
  line(`Running ${linked.rows.length} submissions as ${cohortKey}, run ${runIndex}.`)
  line('Scan, probe and score, through the same path a real entry takes. This is slow.')

  const resume = args.number('resume', 0)
  const summary = await go(() => runBatch({
    challengeIds, cohortKey, runIndex: runIndex as 1 | 2, startedBy: actor,
    // Named, not selected: golden entries are excluded from ordinary runs (migration 091), so
    // the run that scores them says which submissions it means.
    submissionIds: linked.rows.map((r) => Number(r.submission_id)),
    ...(resume !== 0 && { resumeRunId: resume }),
    ...(args.has('discovery') && { withDiscovery: true }),
  }))

  heading(`Run ${summary.scoreRunId} — ${summary.status}`)
  line(`batch run ${summary.runId}`)
  table(['stage', 'ok', 'failed', 'skipped'], Object.entries(summary.perStage).map(
    ([name, s]) => [name, String(s.ok), String(s.failed), String(s.skipped)]))
  line('')
  line(`cost  $${summary.costUsd.toFixed(2)}`)
  if (summary.pausedReason) {
    line(`paused: ${summary.pausedReason}`)
    // Resuming skips the work already done, so a pause costs the reason and not the cohort.
    line('')
    line(`Fix that, then:  pnpm calibration score --set ${setId} --run ${runIndex} `
      + `--resume ${summary.runId} --actor ${actor}`)
  }
  if (summary.finish?.note) line(summary.finish.note)

  for (const failure of summary.failures.slice(0, 10)) {
    line(`  · ${failure.stage} ${failure.subjectId ?? ''}: ${failure.message.slice(0, 90)}`)
  }

  line('')
  line(`Next:  pnpm calibration report --set ${setId} --run ${summary.scoreRunId} --actor ${actor}`)
}

interface RepoRow {
  label: string; repoUrl: string; band: string; edgeCase: string | null
  buildMethod: 'DOCKERFILE' | 'COMMAND'; buildCommand: string | null; dockerfilePath: string | null
}

function readRepoFile(csv: string): RepoRow[] {
  const records = parseCsv(csv)
  if (records.length < 2) throw new UsageError('That file has a header and no repositories.')

  const at = headerIndex(records[0]!.cells, COLUMNS)
  const optional = records[0]!.cells.map((c) => c.trim().toLowerCase())
  const build = optional.indexOf('build_method')
  const command = optional.indexOf('build_command')
  const dockerfile = optional.indexOf('dockerfile_path')

  return records.slice(1).map((record) => {
    const cell = (i: number) => (i < 0 ? '' : (record.cells[i] ?? '').trim())
    const method = cell(build).toUpperCase() === 'COMMAND' ? 'COMMAND' as const : 'DOCKERFILE' as const
    const edge = cell(at['edge_case']!)
    return {
      label: cell(at['label']!),
      repoUrl: cell(at['repo_url']!),
      band: (cell(at['band']!) || 'MIDDLING').toUpperCase(),
      edgeCase: edge === '' ? null : edge.toUpperCase(),
      buildMethod: method,
      buildCommand: method === 'COMMAND' ? (cell(command) || 'npm ci && npm run build') : null,
      // Defaulted rather than guessed at: validation reports the truth once it clones.
      dockerfilePath: method === 'DOCKERFILE' ? (cell(dockerfile) || 'Dockerfile') : null,
    }
  })
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const COMMANDS: Record<string, (args: Args) => Promise<void>> = {
  status: async () => statusCommand(),
  bootstrap: bootstrapCommand,
  score: scoreCommand,
  link: linkCommand,
  rank: rankCommand,
  readiness: readinessCommand,
  seal: sealCommand,
  criteria: criteriaCommand,
  report: reportCommand,
  decide: decideCommand,
  holistic: holisticCommand,
  compare: compareCommand,
}

await run(USAGE, async () => {
  const args = parseArgs(process.argv.slice(2))
  const command = COMMANDS[args.command]
  if (!command) {
    throw new UsageError(args.command === ''
      ? 'No command given.'
      : `There is no "${args.command}" command.`)
  }
  installAuditPort()
  try {
    await command(args)
  } finally {
    await closePool()
  }
})
