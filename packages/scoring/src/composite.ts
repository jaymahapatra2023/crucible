/**
 * Composite scoring and ranking (E07-S04, E07-S06), and run-to-run variance (E06-S06).
 *
 * The plan is explicit that this produces a ranked list of about 25 for review and **does not
 * mark 20 as selected** (E07-S04 acceptance 3). That is P0's first constraint — shortlist, don't
 * decide — expressed in code: nothing here returns a selection.
 */
import { DIMENSIONS, ADVISORY_DIMENSIONS, type Dimension, type DimensionWeights } from '@crucible/rubric'
import { round, type DimensionScore } from './aggregate.js'
import type { NormalisationResult } from './normalise.js'

export interface CompositeInput {
  submissionId: number
  challengeId: number
  dimensions: readonly DimensionScore[]
  /**
   * Fidelity after within-cohort normalisation (E07-S02), or null when fidelity could not be
   * scored at all.
   *
   * Null rather than a zero-valued result: there is no standing to report for a submission
   * whose fidelity was never established, and inventing one would put a real number in an
   * appeal packet that no evidence supports.
   */
  fidelity: NormalisationResult | null
  weights: DimensionWeights
}

export interface CompositeScore {
  submissionId: number
  challengeId: number
  composite: number
  /** Null when fidelity was not scored; never zero-filled. */
  fidelityRaw: number | null
  fidelityNormalised: number | null
  cohortSize: number
  normalisationMethod: NormalisationResult['method'] | 'UNSCORED'
  /** Dimensions that contributed nothing because nothing in them could be scored. */
  missingDimensions: Dimension[]
  /** Share of the rubric's weight that was actually scoreable, 0–1. */
  weightCovered: number
  /** True when any contributing dimension was PARTIAL. */
  partial: boolean
}

/**
 * The value each dimension contributes, and whether it contributes at all.
 *
 * Fidelity enters normalised; every other dimension enters as scored (E07-S02 acceptance 4).
 * A dimension with no value is collected as missing rather than folded in as zero.
 */
function combine(
  input: CompositeInput,
  byDimension: ReadonlyMap<Dimension, DimensionScore>,
): { weighted: number; weightCovered: number; missing: Dimension[]; partial: boolean } {
  let weighted = 0
  let weightCovered = 0
  const missing: Dimension[] = []
  let partial = false

  for (const dimension of DIMENSIONS) {
    const weight = input.weights[dimension]
    if (weight <= 0) continue

    const scored = byDimension.get(dimension)
    const value = dimension === 'CHALLENGE_FIDELITY'
      ? input.fidelity?.normalised ?? null
      : scored?.score ?? null

    if (value === null) {
      missing.push(dimension)
      continue
    }
    if (scored?.dataQuality === 'PARTIAL') partial = true

    weighted += value * weight
    weightCovered += weight
  }

  return { weighted, weightCovered, missing, partial }
}

/**
 * Combine dimension scores into one composite.
 *
 * A dimension that could not be scored is excluded and the remaining weights are renormalised —
 * the same rule as within a dimension (E07-S01 acceptance 3), applied one level up. Scoring an
 * unmeasured dimension as zero would punish a submission for our inability to measure it.
 */
export function computeComposite(input: CompositeInput): CompositeScore {
  const byDimension = new Map(input.dimensions.map((d) => [d.dimension, d]))
  const { weighted, weightCovered, missing, partial } = combine(input, byDimension)

  return {
    submissionId: input.submissionId,
    challengeId: input.challengeId,
    composite: weightCovered === 0 ? 0 : round(weighted / weightCovered),
    fidelityRaw: input.fidelity === null ? null : round(input.fidelity.raw),
    fidelityNormalised: input.fidelity === null ? null : round(input.fidelity.normalised),
    cohortSize: input.fidelity?.cohortSize ?? 0,
    normalisationMethod: input.fidelity?.method ?? 'UNSCORED',
    missingDimensions: missing,
    weightCovered: round(weightCovered),
    partial: partial || missing.length > 0,
  }
}

export interface RankedSubmission extends CompositeScore {
  rankGlobal: number
  rankInChallenge: number
  /** True when this submission shares its composite with another at the same rank. */
  tied: boolean
}

/**
 * Rank globally and within challenge.
 *
 * Ties are broken by a documented, deterministic rule (E07-S04 acceptance 2):
 *   1. composite, descending
 *   2. share of the rubric's weight that was scoreable, descending — a submission judged on more
 *      of the rubric is the better-evidenced result
 *   3. submission id, ascending — arbitrary, but stable, and stated
 *
 * Submissions genuinely tied on composite are marked `tied` so E07-S06 can surface ties at the
 * cut line rather than letting rule 3 silently decide who is eliminated.
 */
export function rank(scores: readonly CompositeScore[]): RankedSubmission[] {
  const ordered = [...scores].sort((a, b) =>
    b.composite - a.composite ||
    b.weightCovered - a.weightCovered ||
    a.submissionId - b.submissionId)

  const compositeCounts = new Map<number, number>()
  for (const s of scores) {
    compositeCounts.set(s.composite, (compositeCounts.get(s.composite) ?? 0) + 1)
  }

  const inChallenge = new Map<number, number>()

  return ordered.map((score, index) => {
    const next = (inChallenge.get(score.challengeId) ?? 0) + 1
    inChallenge.set(score.challengeId, next)
    return {
      ...score,
      rankGlobal: index + 1,
      rankInChallenge: next,
      tied: (compositeCounts.get(score.composite) ?? 0) > 1,
    }
  })
}

export interface VarianceResult {
  submissionId: number
  compositeA: number
  compositeB: number
  delta: number
  /** True when the two runs place the submission on opposite sides of the cut line. */
  straddlesCut: boolean
  /** True when the two runs disagree by more than the configured threshold. */
  exceedsThreshold: boolean
  /**
   * Global rank in each run. Never null: a submission missing from either run is not compared
   * at all, because a comparison against an absent run would report perfect agreement.
   */
  rankA: number
  rankB: number
}

/**
 * Compare two scoring runs (E06-S06).
 *
 * Two independent conditions raise a flag, and they catch different things:
 *
 *  - **Straddling the cut** — the runs disagree about whether this team is in or out. That is
 *    the case where non-determinism actually changes an outcome, and it routes to a human
 *    automatically (acceptance 3).
 *  - **A large delta anywhere** — the runs disagree substantially even if both agree on the
 *    outcome (acceptance 4). A team ranked 3rd and 19th is a warning about the scorer whether or
 *    not the cut line is nearby.
 */
export function compareRuns(input: {
  runA: readonly RankedSubmission[]
  runB: readonly RankedSubmission[]
  cutLine: number
  deltaThreshold: number
}): VarianceResult[] {
  const byIdB = new Map(input.runB.map((s) => [s.submissionId, s]))
  const results: VarianceResult[] = []

  for (const a of input.runA) {
    const b = byIdB.get(a.submissionId)
    if (!b) continue

    const insideA = a.rankGlobal <= input.cutLine
    const insideB = b.rankGlobal <= input.cutLine
    const delta = round(Math.abs(a.composite - b.composite))

    results.push({
      submissionId: a.submissionId,
      compositeA: a.composite,
      compositeB: b.composite,
      delta,
      straddlesCut: insideA !== insideB,
      exceedsThreshold: delta > input.deltaThreshold,
      rankA: a.rankGlobal,
      rankB: b.rankGlobal,
    })
  }

  return results.sort((x, y) => y.delta - x.delta || x.submissionId - y.submissionId)
}

/** Submissions near the boundary, where human attention changes outcomes (E07-S06). */
export function cutBand(
  ranked: readonly RankedSubmission[], cutLine: number, bandSize: number,
): RankedSubmission[] {
  const low = Math.max(1, cutLine - bandSize)
  const high = cutLine + bandSize
  return ranked.filter((s) => s.rankGlobal >= low && s.rankGlobal <= high)
}

/**
 * Would this submission's position change if the advisory dimension were removed?
 *
 * E06-S05 acceptance 3 forbids originality being the sole reason a submission falls below the
 * cut, and E07-S06 acceptance 3 requires such a case to be called out. This answers it by
 * recomputing without the advisory dimensions and comparing sides of the line.
 *
 * Built and tested here because both epics need it, but NOT yet wired into any report: the
 * surface that must carry the call-out is E07-S06's, and inventing a second one now would mean
 * two places claiming to answer the same question.
 */
export function advisoryDecided(input: {
  score: CompositeScore
  dimensions: readonly DimensionScore[]
  weights: DimensionWeights
  cutLine: number
  rankGlobal: number
  allScores: readonly CompositeScore[]
}): boolean {
  const withoutAdvisory: DimensionWeights = { ...input.weights }
  for (const dimension of ADVISORY_DIMENSIONS) withoutAdvisory[dimension] = 0

  const recomputed = computeComposite({
    submissionId: input.score.submissionId,
    challengeId: input.score.challengeId,
    dimensions: input.dimensions,
    // Rebuilt from the already-normalised figures rather than re-normalised: the cohort has
    // not changed, and re-deriving it here could produce a different standing than the one the
    // submission was actually ranked by.
    fidelity: input.score.fidelityNormalised === null || input.score.fidelityRaw === null
      || input.score.normalisationMethod === 'UNSCORED'
      ? null
      : {
          normalised: input.score.fidelityNormalised,
          raw: input.score.fidelityRaw,
          cohortSize: input.score.cohortSize,
          method: input.score.normalisationMethod,
          note: null,
        },
    weights: withoutAdvisory,
  })

  // Where would it rank if the advisory dimension had not counted?
  const better = input.allScores.filter((s) =>
    s.submissionId !== input.score.submissionId && s.composite > recomputed.composite).length

  const rankWithout = better + 1
  return (input.rankGlobal > input.cutLine) !== (rankWithout > input.cutLine)
}
