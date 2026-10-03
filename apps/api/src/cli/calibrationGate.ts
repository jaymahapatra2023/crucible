/**
 * The gate steps of the calibration CLI: rank, seal, criteria, report, decide.
 *
 * Split from `calibration.ts` by subject rather than by size: that file builds the set and gets
 * it scored, this one runs the gate over it.
 */
import { withCorrelation } from '../lib/correlation.js'
import {
  readiness, recordRanking, seal, entriesFor,
} from '../modules/calibration/services/goldenSetService.js'
import { decide, recordCriteria } from '../modules/calibration/services/gateService.js'
import { generateReport } from '../modules/calibration/services/calibrationReport.js'
import { heading, line, table, UsageError, type Args } from './args.js'
import { readFile } from 'node:fs/promises'

const go = <T>(fn: () => Promise<T>) =>
  withCorrelation({ correlationId: 'cli-calibration' }, fn)

/**
 * Record one person's ordering, read from a file of labels, best first.
 *
 * One ranker per invocation and the ranker named explicitly, because the whole value of the hand
 * ranking is that each ordering is one person's own. A file makes that practical without the two
 * of them looking at the same screen.
 */
export async function rankCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required: the golden set to rank.')
  const ranker = args.require('ranker', 'the email of the person whose ordering this is.')
  const file = args.require('file', 'a file of entry labels, best first, one per line.')

  const wanted = (await readFile(file, 'utf8'))
    .split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))

  const entries = await entriesFor(setId)
  const byLabel = new Map(entries.map((e) => [e.label.toLowerCase(), Number(e.entry_id)]))

  const unknown = wanted.filter((label) => !byLabel.has(label.toLowerCase()))
  if (unknown.length > 0) {
    throw new UsageError(
      `These lines name nothing in the set: ${unknown.join(', ')}.\n`
      + `Labels in the set: ${entries.map((e) => e.label).join(', ')}`)
  }
  if (wanted.length !== entries.length) {
    // Ranking six of eight is not an ordering, and the service refuses it anyway.
    throw new UsageError(
      `The file orders ${wanted.length} of ${entries.length} entries. A partial ordering says `
      + `nothing about the ones left out.`)
  }

  await go(() => recordRanking({
    goldenSetId: setId, ranker,
    positions: wanted.map((label, i) => ({
      entryId: byLabel.get(label.toLowerCase())!, position: i + 1, rationale: `from ${file}`,
    })),
    actor: ranker,
  }))

  line(`Recorded ${wanted.length} positions for ${ranker}.`)
  await readinessCommand(args)
}

export async function readinessCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required.')

  const state = await readiness(setId)
  heading(`Golden set ${setId}`)
  line(`entries   ${state.entries}`)
  line(`rankers   ${state.rankers.length === 0 ? '(none)' : state.rankers.join(', ')}`)
  line(`can seal  ${state.canSeal ? 'yes' : 'no'}`)
  if (state.problems.length > 0) {
    line('')
    for (const problem of state.problems) line(`  · ${problem}`)
  }
}

export async function sealCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required.')
  const actor = args.require('actor', 'who is sealing it; this is recorded.')

  await go(() => seal(setId, actor))
  line(`Sealed. The gate decision will rest on exactly this set and these rankings.`)
}

/**
 * Write the thresholds down, before the report exists.
 *
 * The order is the point and the server enforces it: criteria chosen once the number they have
 * to clear is known are not criteria.
 */
export async function criteriaCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required.')

  await go(() => recordCriteria({
    goldenSetId: setId,
    minRankCorrelation: args.number('min-rho', 0.7),
    maxMaterialDisagreements: args.number('max-disagreements', 2),
    materialRankGap: args.number('rank-gap', 3),
    maxRunVariance: args.number('max-variance', 10),
    fallbackPlan: args.require('fallback',
      'what happens on a NO_GO. Writing it down now is the point of recording it.'),
    notes: args.flag('notes') ?? '',
    actor: args.require('actor', 'who recorded these; this is recorded.'),
  }))
  line('Criteria recorded. A report can now be produced against them.')
}

export async function reportCommand(args: Args): Promise<void> {
  const setId = args.number('set', 0)
  if (setId === 0) throw new UsageError('--set is required.')
  const runIndexId = args.number('run', 0)
  if (runIndexId === 0) {
    throw new UsageError('--run is required: the score run to compare against (see `status`).')
  }

  const report = await go(() => generateReport({
    goldenSetId: setId, runIndexId,
    ...(args.flag('cohort') !== null && { cohortKey: args.flag('cohort')! }),
    actor: args.require('actor', 'who generated it; this is recorded.'),
  }))

  const detail = report.detail as {
    disagreements: Array<{
      label: string; humanRank: number; machineRank: number; delta: number
      material: boolean; edgeCase: string | null
    }>
    dimensions: Array<{ dimension: string; correlation: { rho: number | null; n: number } }>
  }

  heading(`Calibration report ${report.report_id}`)
  line(`rank correlation        ${report.rank_correlation ?? 'not computable'}`)
  line(`sample size             ${report.sample_size}`)
  line(`material disagreements  ${report.material_disagreements}`)
  if (report.correlation_note) line(`note                    ${report.correlation_note}`)

  heading('Where it disagrees with the committee')
  table(
    ['entry', 'human', 'machine', 'delta', 'material', 'edge case'],
    detail.disagreements.map((d) => [
      d.label, String(d.humanRank), String(d.machineRank), String(d.delta),
      d.material ? 'YES' : '', d.edgeCase ?? '',
    ]))

  heading('Agreement by dimension, weakest first')
  if (detail.dimensions.length === 0) {
    line('No dimension was scored for enough entries to compare.')
  } else {
    table(['dimension', 'rho', 'n'], detail.dimensions.map((d) => [
      d.dimension, String(d.correlation.rho ?? '—'), String(d.correlation.n),
    ]))
  }

  line('')
  line(`Record the decision with:  pnpm calibration decide --report ${report.report_id} \\`)
  line('    --decision GO|NO_GO --rationale "..." --actor you@example.com')
}

export async function decideCommand(args: Args): Promise<void> {
  const reportId = args.number('report', 0)
  if (reportId === 0) throw new UsageError('--report is required.')

  const raw = args.require('decision', 'GO or NO_GO.').toUpperCase()
  if (raw !== 'GO' && raw !== 'NO_GO') {
    throw new UsageError(`--decision must be GO or NO_GO, not "${raw}".`)
  }

  const decision = await go(() => decide({
    reportId, decision: raw,
    rationale: args.require('rationale',
      'why. A decision without one cannot be reviewed afterwards.'),
    actor: args.require('actor', 'who decided; this is recorded.'),
  }))
  line(`${decision.decision} recorded against report ${reportId}.`)
}
