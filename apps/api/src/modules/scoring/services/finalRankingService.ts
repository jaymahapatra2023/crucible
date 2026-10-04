/**
 * One ordering from two runs (E50).
 *
 * Each cohort is scored twice (E06-S06). Until this review the two runs were ranked separately
 * and only COMPARED; the event's result is one list, so here the two composites are combined —
 * a weighted mean, weights from configuration — and ranked with the very same tie rule the
 * per-run rankings use (`rank` from the scoring package). Nothing is recomputed from criterion
 * scores: the inputs are the two STORED rankings, so this list can always be traced to them.
 *
 * Averaging must not hide disagreement (the reason E06-S06 refused to average). So every final
 * row carries both composites, the delta, and a `disagreement` mark when the runs differ by
 * more than the variance threshold or straddle the cut line — the same two conditions the
 * variance report flags. A submission scored in only one run keeps that composite and is marked
 * `single_run` rather than having its number silently halved.
 */
import { cutBand, rank, type CompositeScore } from '@crucible/scoring'
import { AppError } from '../../../lib/appError.js'
import { createLogger } from '../../../lib/logger.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { csvDocument } from '../../../lib/csv.js'
import { getJson, getNumber } from '../../platform/services/configService.js'
import { assertRankingPermitted } from '../../calibration/services/gateService.js'
import { selectRunsForCohort } from '../db/scoringDb.js'
import { selectRanking, selectSnapshot, type CompositeRow } from '../db/rankingDb.js'
import {
  replaceFinalRanking, selectFinalRanking, selectFinalSnapshot, type FinalRow, type FinalSnapshotRow,
} from '../db/finalRankingDb.js'

const log = createLogger('scoring', 'finalRanking')

export interface MergeInput {
  run1: readonly CompositeRow[]
  run2: readonly CompositeRow[]
  weights: { 1: number; 2: number }
  cutLine: number
  bandSize: number
  deltaThreshold: number
}

const round = (n: number): number => Math.round(n * 1000) / 1000

type Pair = { a?: CompositeRow; b?: CompositeRow }
type Scored = CompositeScore & Pair

/** The two runs side by side, by submission. */
function pairRuns(run1: readonly CompositeRow[], run2: readonly CompositeRow[]): Map<number, Pair> {
  const byId = new Map<number, Pair>()
  for (const r of run1) byId.set(r.submission_id, { a: r })
  for (const r of run2) byId.set(r.submission_id, { ...byId.get(r.submission_id), b: r })
  return byId
}

/**
 * How much of the rubric the LESS complete of the two runs managed to score.
 *
 * The worse of the two, deliberately. A merged composite is only as comparable as the run that
 * read least of the rubric, and taking the better figure would hide exactly the gap this number
 * exists to show. A run that is missing entirely does not drag it down — there is nothing to
 * know about a run that did not happen, and `single_run` already says so.
 */
function worstCoverage(a: CompositeRow | undefined, b: CompositeRow | undefined): number {
  const present = [a, b].filter((r): r is CompositeRow => r !== undefined)
  if (present.length === 0) return 1
  return Math.min(...present.map((r) => Number(r.criterion_coverage ?? 1)))
}

/** One composite from a pair: the weighted mean, or the only run's number when one is missing. */
function combined(submissionId: number, pair: Pair, weights: MergeInput['weights']): Scored {
  const { a, b } = pair
  const base = (a ?? b)!
  const composite = a && b
    ? round(Number(a.composite) * weights[1] + Number(b.composite) * weights[2])
    : round(Number(base.composite))
  return {
    submissionId, challengeId: base.challenge_id, composite,
    fidelityRaw: base.fidelity_raw === null ? null : Number(base.fidelity_raw),
    fidelityNormalised: base.fidelity_normalised === null ? null : Number(base.fidelity_normalised),
    cohortSize: base.cohort_size,
    normalisationMethod: base.normalisation_method as CompositeScore['normalisationMethod'],
    missingDimensions: base.missing_dimensions as CompositeScore['missingDimensions'],
    weightCovered: Math.max(Number(a?.weight_covered ?? 0), Number(b?.weight_covered ?? 0)),
    criterionCoverage: worstCoverage(a, b),
    partial: (a?.partial ?? false) || (b?.partial ?? false),
    a, b,
  }
}

/** Whether a human should look: the same two conditions the variance report flags. */
function disagreement(pair: Pair, delta: number | null, cutLine: number, threshold: number): boolean {
  const { a, b } = pair
  const straddles = a !== undefined && b !== undefined
    && (a.rank_global <= cutLine) !== (b.rank_global <= cutLine)
  return straddles || (delta !== null && delta > threshold)
}

/** Pure: the combined, ranked rows. Unit-tested without a database. */
export function mergeRuns(input: MergeInput): Array<Omit<FinalRow, 'cohort_key'>> {
  const pairs = pairRuns(input.run1, input.run2)
  const scores = [...pairs].map(([id, pair]) => combined(id, pair, input.weights))
  const ranked = rank(scores)
  const band = new Set(cutBand(ranked, input.cutLine, input.bandSize).map((r) => r.submissionId))

  return ranked.map((r) => {
    const pair = pairs.get(r.submissionId)!
    const c1 = pair.a ? Number(pair.a.composite) : null
    const c2 = pair.b ? Number(pair.b.composite) : null
    const delta = c1 !== null && c2 !== null ? round(Math.abs(c1 - c2)) : null
    return {
      submission_id: r.submissionId, challenge_id: r.challengeId, team_name: (pair.a ?? pair.b)!.team_name,
      composite_run1: c1, composite_run2: c2, composite_final: r.composite,
      single_run: pair.a === undefined || pair.b === undefined, delta,
      rank_global: r.rankGlobal, rank_in_challenge: r.rankInChallenge, tied: r.tied,
      in_cut_band: band.has(r.submissionId),
      disagreement: disagreement(pair, delta, input.cutLine, input.deltaThreshold),
      partial: r.partial,
    }
  })
}

async function runWeights(): Promise<{ 1: number; 2: number }> {
  const raw = await getJson<Record<string, unknown>>('scoring.run_weights')
  const w1 = Number(raw['1']); const w2 = Number(raw['2'])
  if (!Number.isFinite(w1) || !Number.isFinite(w2) || w1 < 0 || w2 < 0 || Math.abs(w1 + w2 - 1) > 0.001) {
    throw new AppError('PRECONDITION_FAILED',
      'scoring.run_weights must give run 1 and run 2 non-negative weights that sum to 1, e.g. {"1": 0.5, "2": 0.5}.')
  }
  return { 1: w1, 2: w2 }
}

export async function computeFinalRanking(cohortKey: string, actor: string): Promise<FinalRankingView> {
  await assertRankingPermitted()
  const runs = await selectRunsForCohort(cohortKey)
  const run1 = runs.find((r) => r.run_index === 1)
  const run2 = runs.find((r) => r.run_index === 2)
  if (!run1 || !run2) {
    throw new AppError('PRECONDITION_FAILED',
      `Cohort '${cohortKey}' has ${runs.length} scoring run(s). The final ranking needs both run 1 and run 2 — `
      + 'score the cohort twice first.')
  }
  for (const run of [run1, run2]) {
    if (!(await selectSnapshot(run.run_index_id))) {
      throw new AppError('PRECONDITION_FAILED',
        `Run ${run.run_index} of cohort '${cohortKey}' has no stored ranking. Rank it first; the final `
        + 'list is built from the two stored rankings, not recomputed.')
    }
  }

  const [weights, cutLine, bandSize, deltaThreshold, r1, r2] = await Promise.all([
    runWeights(), getNumber('scoring.cut_line'), getNumber('scoring.cut_band_size'),
    getNumber('scoring.variance_delta_threshold'),
    selectRanking(run1.run_index_id), selectRanking(run2.run_index_id),
  ])
  const rows = mergeRuns({ run1: r1, run2: r2, weights, cutLine, bandSize, deltaThreshold })
  if (rows.length === 0) {
    throw new AppError('PRECONDITION_FAILED', `Neither run of cohort '${cohortKey}' ranked anybody.`)
  }

  await replaceFinalRanking(rows, {
    cohort_key: cohortKey, run1_index_id: run1.run_index_id, run2_index_id: run2.run_index_id,
    weights, cut_line_used: cutLine, band_size_used: bandSize, threshold_used: deltaThreshold,
    submissions: rows.length, computed_by: actor,
  })
  await recordAudit({
    actor, action: 'scoring.final_ranking_computed', subjectType: 'cohort', subjectId: cohortKey,
    payload: {
      runs: [run1.run_index_id, run2.run_index_id], weights, submissions: rows.length,
      disagreements: rows.filter((r) => r.disagreement).length,
      singleRun: rows.filter((r) => r.single_run).length,
    },
  })
  log.info('final ranking computed', { cohortKey, submissions: rows.length })
  return getFinalRanking(cohortKey)
}

export interface FinalRankingView {
  cohortKey: string
  ranked: FinalRow[]
  snapshot: FinalSnapshotRow | null
  /** A per-run ranking was recomputed after this final one: the list may no longer follow. */
  stale: boolean
  runs: { run1IndexId: number | null; run2IndexId: number | null }
}

export async function getFinalRanking(cohortKey: string): Promise<FinalRankingView> {
  const [ranked, snapshot, runs] = await Promise.all([
    selectFinalRanking(cohortKey), selectFinalSnapshot(cohortKey), selectRunsForCohort(cohortKey),
  ])
  const run1 = runs.find((r) => r.run_index === 1) ?? null
  const run2 = runs.find((r) => r.run_index === 2) ?? null
  let stale = false
  if (snapshot) {
    for (const id of [snapshot.run1_index_id, snapshot.run2_index_id]) {
      const s = await selectSnapshot(id)
      if (s && s.computed_at > snapshot.computed_at) stale = true
    }
  }
  return {
    cohortKey, ranked, snapshot, stale,
    runs: { run1IndexId: run1?.run_index_id ?? null, run2IndexId: run2?.run_index_id ?? null },
  }
}

export async function finalRankingCsv(cohortKey: string): Promise<string> {
  const view = await getFinalRanking(cohortKey)
  return csvDocument(
    ['rank', 'team', 'submission_id', 'challenge_id', 'rank_in_challenge', 'composite_final',
      'composite_run1', 'composite_run2', 'delta', 'disagreement', 'single_run', 'tied', 'in_cut_band', 'partial'],
    view.ranked.map((r) => [r.rank_global, r.team_name, r.submission_id, r.challenge_id,
      r.rank_in_challenge, r.composite_final, r.composite_run1, r.composite_run2, r.delta,
      r.disagreement, r.single_run, r.tied, r.in_cut_band, r.partial]),
  )
}
