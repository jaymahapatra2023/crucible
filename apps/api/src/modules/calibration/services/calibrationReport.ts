/**
 * Comparing machine ranking against human judgement (E11-S02).
 *
 * Refuses to run against an unsealed golden set. That refusal IS acceptance 3 of E11-S01: a
 * report produced while hand rankings can still be edited proves nothing about the machine.
 *
 * The report deliberately carries three things rather than one number, because the go/no-go
 * decision cannot be made from a coefficient alone:
 *
 *  1. the rank correlation, with its sample size and any reason it could not be computed;
 *  2. every material disagreement, individually, with the evidence behind it — a ρ of 0.71 can
 *     hide the strongest repository being ranked last;
 *  3. which dimension's ordering least resembles the human one, which is usually more
 *     actionable than the composite figure.
 */
import {
  dimensionAgreement, disagreements, interRaterAgreement, spearman,
} from '@crucible/scoring'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { selectRanking, selectDimensionScores } from '../../scoring/db/rankingDb.js'
import { selectRunsForCohort } from '../../scoring/db/scoringDb.js'
import { selectVariance } from '../../scoring/db/varianceDb.js'
import { entriesFor, requireSet } from './goldenSetService.js'
import { selectRankings } from '../db/calibrationDb.js'
import { currentCriteria, insertReport, type ReportRow } from '../db/gateDb.js'

const log = createLogger('calibration', 'report')

/**
 * Fewest entries a per-dimension correlation is worth reporting over.
 *
 * A dimension scored for three of thirteen repositories produces a number, and the number is
 * noise. Reporting it beside the composite correlation would invite it to be acted on.
 */
const MINIMUM_DIMENSION_SAMPLE = 5

export interface CalibrationInput {
  goldenSetId: number
  runIndexId: number
  cohortKey?: string
  actor: string
}

export async function generateReport(input: CalibrationInput): Promise<ReportRow> {
  const set = await requireSet(input.goldenSetId)
  if (set.status !== 'SEALED') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Golden set ${input.goldenSetId} is not sealed. A calibration report against a set whose ` +
        `hand rankings can still be edited proves nothing about the machine (E11-S01).`,
    )
  }

  // E11-S03 acceptance 1: the criteria must predate the report. Without them there is no
  // threshold to judge against, and a number produced first invites one to be chosen after.
  const criteria = await currentCriteria(input.goldenSetId)
  if (!criteria) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `No gate criteria have been recorded for this golden set. They must be written down ` +
        `BEFORE the report (E11-S03), so that the threshold is not chosen once the number it ` +
        `has to clear is known.`,
    )
  }

  const [entries, humanRows, machineRanking] = await Promise.all([
    entriesFor(input.goldenSetId),
    selectRankings(input.goldenSetId),
    selectRanking(input.runIndexId),
  ])

  const bySubmission = new Map(
    entries.filter((e) => e.submission_id !== null).map((e) => [e.submission_id!, e]))

  const machine = machineRanking
    .filter((m) => bySubmission.has(m.submission_id))
    .map((m) => ({
      entryId: String(bySubmission.get(m.submission_id)!.entry_id),
      rank: m.rank_global,
      submissionId: m.submission_id,
    }))

  if (machine.length === 0) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `None of this golden set's entries appear in run ${input.runIndexId}. Score the set ` +
        `before comparing against it.`,
    )
  }

  const human = consensusRanking(humanRows, entries.map((e) => e.entry_id))
  const machineByEntry = new Map(machine.map((m) => [m.entryId, m.rank]))

  // Compared over the entries BOTH orderings contain: an entry the machine never ranked would
  // otherwise silently count as agreement.
  const shared = human.filter((h) => machineByEntry.has(h.entryId))
  const correlation = spearman(
    shared.map((h) => h.rank),
    shared.map((h) => machineByEntry.get(h.entryId)!),
  )

  const gaps = disagreements(shared, machine, criteria.material_rank_gap)
  const material = gaps.filter((g) => g.material)

  /*
   * How much the humans agree with EACH OTHER — the denominator the figure above is read
   * against (E33). Computed over the same entries the machine comparison used, so the two
   * numbers describe the same set of repositories.
   *
   * This does NOT change the gate's thresholds. Those were recorded before the report on
   * purpose (E11-S03), and moving them now would be choosing a bar once the number is known.
   * What it changes is whether the person taking the decision can interpret what they are
   * looking at.
   */
  const raters = interRaterAgreement(
    humanRows
      .filter((r) => machineByEntry.has(String(r.entry_id)))
      .map((r) => ({ entryId: String(r.entry_id), ranker: r.ranker, position: r.position })),
  )

  const dimensions = await dimensionDisagreement(input.runIndexId, shared, bySubmission)
  const variance = await runVariance(input.cohortKey, machine.map((m) => m.submissionId))

  const report = await insertReport({
    goldenSetId: input.goldenSetId,
    criteriaId: criteria.criteria_id,
    runIndexId: input.runIndexId,
    secondRunIndexId: variance.secondRunIndexId,
    rankCorrelation: correlation.rho,
    // The agreement note travels WITH the coefficient rather than beside it. A reader who sees
    // the number is the reader who has to know it is being measured against noise.
    correlationNote: qualify(correlation.note, raters),
    sampleSize: correlation.n,
    materialDisagreements: material.length,
    maxRunVariance: variance.maxDelta,
    detail: {
      interRater: raters,
      perRanker: perRankerCorrelation(humanRows, machineByEntry),
      disagreements: gaps.map((g) => ({
        ...g,
        label: entries.find((e) => String(e.entry_id) === g.entryId)?.label ?? g.entryId,
        expectedBand: entries.find((e) => String(e.entry_id) === g.entryId)?.expected_band,
        edgeCase: entries.find((e) => String(e.entry_id) === g.entryId)?.edge_case,
      })),
      dimensions,
      humanRanking: shared,
      machineRanking: machine,
      varianceFlagged: variance.flagged,
    },
    generatedBy: input.actor,
  })

  await recordAudit({
    actor: input.actor, action: 'calibration.report_generated',
    subjectType: 'golden_set', subjectId: String(input.goldenSetId),
    payload: {
      reportId: report.report_id, criteriaId: criteria.criteria_id,
      rho: correlation.rho, material: material.length,
      // Recorded beside the coefficient so the audit trail carries what it was measured
      // against, not only what it came to.
      raterAgreement: raters.strength, raterLowest: raters.lowest,
    },
  })
  log.info('calibration report generated', {
    goldenSetId: input.goldenSetId, rho: correlation.rho, material: material.length,
    raterAgreement: raters.strength,
  })

  return report
}

/**
 * The coefficient's note, carrying how much the humans agreed with each other.
 *
 * Only where it changes how the number should be read. A strong consensus needs no caveat, and
 * appending one to every report would teach readers to skip the note.
 */
function qualify(note: string | null, raters: { strength: string; note: string }): string | null {
  if (raters.strength === 'STRONG') return note
  // A null note means the coefficient needed no explanation of its own. It still needs this
  // one, so the field stops being null rather than the caveat being dropped.
  const prefix = note === null || note.trim() === '' ? '' : `${note.trim()} `
  return `${prefix}RANKER AGREEMENT: ${raters.note}`
}

/**
 * One ordering from several people's.
 *
 * Averaged positions, then re-ranked. Averaging is the honest aggregation of independent
 * judgements: taking the first ranker's and calling it the consensus would make the second
 * person's work decorative, and there is no principled reason to prefer either.
 */
export function consensusRanking(
  rows: ReadonlyArray<{ entry_id: number; ranker: string; position: number }>,
  entryIds: readonly number[],
): Array<{ entryId: string; rank: number }> {
  const sums = new Map<number, { total: number; count: number }>()
  for (const row of rows) {
    const current = sums.get(row.entry_id) ?? { total: 0, count: 0 }
    sums.set(row.entry_id, { total: current.total + row.position, count: current.count + 1 })
  }

  const averaged = entryIds
    .filter((id) => sums.has(id))
    .map((id) => ({ entryId: String(id), mean: sums.get(id)!.total / sums.get(id)!.count }))
    .sort((a, b) => a.mean - b.mean)

  return averaged.map((a, index) => ({ entryId: a.entryId, rank: index + 1 }))
}

/** How each individual ranker correlates with the machine, so an outlier ranker is visible. */
function perRankerCorrelation(
  rows: ReadonlyArray<{ entry_id: number; ranker: string; position: number }>,
  machineByEntry: ReadonlyMap<string, number>,
): Array<{ ranker: string; rho: number | null; n: number }> {
  const byRanker = new Map<string, Array<{ entryId: string; position: number }>>()
  for (const row of rows) {
    const list = byRanker.get(row.ranker) ?? []
    list.push({ entryId: String(row.entry_id), position: row.position })
    byRanker.set(row.ranker, list)
  }

  return [...byRanker].map(([ranker, list]) => {
    const shared = list.filter((l) => machineByEntry.has(l.entryId))
    const result = spearman(
      shared.map((s) => s.position),
      shared.map((s) => machineByEntry.get(s.entryId)!),
    )
    return { ranker, rho: result.rho, n: result.n }
  })
}

/** Which dimension's ordering least resembles the human one (acceptance 3). */
async function dimensionDisagreement(
  runIndexId: number,
  human: ReadonlyArray<{ entryId: string; rank: number }>,
  bySubmission: ReadonlyMap<number, { entry_id: number }>,
) {
  const rows = await selectDimensionScores(runIndexId)
  const entryOf = new Map(
    [...bySubmission].map(([submissionId, entry]) => [submissionId, String(entry.entry_id)]))

  const byDimension: Record<string, number[]> = {}
  const ranksFor: Record<string, number[]> = {}

  for (const dimension of new Set(rows.map((r) => r.dimension))) {
    const scores: number[] = []
    const ranks: number[] = []

    for (const entry of human) {
      const row = rows.find(
        (r) => r.dimension === dimension && entryOf.get(r.submission_id) === entry.entryId)
      // An entry this dimension could not be scored for is DROPPED from both sequences rather
      // than zero-filled: a zero would read as "scored badly" and invert the comparison.
      //
      // Dropping the entry, not the dimension. Requiring every entry to be scored excluded
      // every dimension on any realistic cohort — a golden set spans a scaffold and a
      // repository that will not build precisely so that some dimensions cannot be scored —
      // so E11-S02's weakest-dimension finding never appeared at all.
      if (row === undefined || row.score === null) continue
      scores.push(Number(row.score))
      ranks.push(entry.rank)
    }

    // Below this a correlation is arithmetic rather than evidence.
    if (scores.length >= MINIMUM_DIMENSION_SAMPLE) {
      byDimension[dimension] = scores
      ranksFor[dimension] = ranks
    }
  }

  return Object.keys(byDimension).flatMap((dimension) =>
    dimensionAgreement(ranksFor[dimension]!, { [dimension]: byDimension[dimension]! }))
}

/** Run-to-run variance across the golden set (acceptance 2). */
async function runVariance(cohortKey: string | undefined, submissionIds: readonly number[]) {
  if (!cohortKey) return { maxDelta: null, flagged: [], secondRunIndexId: null }

  const [rows, runs] = await Promise.all([
    selectVariance(cohortKey),
    selectRunsForCohort(cohortKey),
  ])
  const inSet = new Set(submissionIds)
  const relevant = rows.filter((r) => inSet.has(r.submission_id))

  return {
    maxDelta: relevant.length === 0
      ? null
      : Math.max(...relevant.map((r) => Number(r.delta))),
    flagged: relevant
      .filter((r) => r.straddles_cut || r.exceeds_threshold)
      .map((r) => ({ submissionId: r.submission_id, delta: Number(r.delta) })),
    secondRunIndexId: runs.find((r) => r.run_index === 2)?.run_index_id ?? null,
  }
}
