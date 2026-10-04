/**
 * Why a submission needs a person to look at it (E07-S03 acceptance 2, E07-S06 acceptance 2).
 *
 * Both stories require affected submissions to be *flagged*, not merely inferable. The
 * distinction matters: a reviewer who has to notice that a normalisation method reads
 * ABSOLUTE_FALLBACK, and know what that implies, will eventually not notice.
 *
 * Ordered by how much the reason should change what a reviewer does, so a list truncated for
 * display still leads with the reason that matters most.
 */
import type { RankedSubmission } from './composite.js'

export type ReviewReason =
  /** Removing the advisory dimension would move it across the cut line (E06-S05 acceptance 3). */
  | 'ADVISORY_DECIDED'
  /** Close enough to the cut line that a person's judgement changes the outcome. */
  | 'IN_CUT_BAND'
  /** Shares a composite with another submission; the order between them is arbitrary. */
  | 'TIED'
  /** The cohort was too small to normalise, so the position rests on absolute scores. */
  | 'COHORT_BELOW_FLOOR'
  /** At least one dimension could not be scored at all. */
  | 'DIMENSION_UNSCORED'
  /** Some criteria within a scored dimension could not be judged. */
  | 'PARTIAL_EVIDENCE'
  /**
   * Too little of the rubric produced a score for the composite to mean anything.
   *
   * Distinct from PARTIAL_EVIDENCE, which says some evidence is missing. This says so much is
   * missing that the number should not be read as a score at all. Measured at the event: across
   * fifteen entries, coverage and rank correlated at +0.61 — the entry ranked first had scored
   * 39% of the rubric and the entry ranked last had scored 91%. Because a dimension averages
   * over the weight it covered, a criterion an entry would have failed RAISES its mark by being
   * absent, so a thin composite does not merely carry more uncertainty, it is biased upward.
   */
  | 'COVERAGE_TOO_LOW'

/** Plain language for each code, for the UI and the export. */
export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  ADVISORY_DECIDED:
    'position depends on the advisory inventiveness dimension, which must not decide it alone',
  IN_CUT_BAND: 'close to the cut line',
  TIED: 'tied composite — the order between ties is arbitrary',
  COHORT_BELOW_FLOOR: 'cohort too small to normalise; scored absolutely',
  DIMENSION_UNSCORED: 'a whole dimension could not be scored',
  PARTIAL_EVIDENCE: 'scored on partial evidence',
  COVERAGE_TOO_LOW:
    'too little of the rubric produced a score — read this as unranked pending review, not as a '
    + 'score, because missing criteria push a composite UP rather than down',
}

export function reviewReasons(input: {
  entry: RankedSubmission
  inCutBand: boolean
  advisoryDecided: boolean
  /** Below this share of the rubric's weight, a composite is not a score. 0 disables it. */
  coverageFloor?: number | undefined
}): ReviewReason[] {
  const { entry } = input
  const reasons: ReviewReason[] = []

  // First, because it is the reason that most changes what a reviewer should do: it says do not
  // read the number. Everything below it qualifies a score; this one withdraws it.
  const floor = input.coverageFloor ?? 0
  if (floor > 0 && entry.criterionCoverage !== undefined
      && entry.criterionCoverage < floor) {
    reasons.push('COVERAGE_TOO_LOW')
  }

  if (input.advisoryDecided) reasons.push('ADVISORY_DECIDED')
  if (input.inCutBand) reasons.push('IN_CUT_BAND')
  if (entry.tied) reasons.push('TIED')
  // Reported wherever the submission sits, not only near the cut line: an absolute score
  // compared against normalised ones is a caveat on the position itself.
  if (entry.normalisationMethod === 'ABSOLUTE_FALLBACK') reasons.push('COHORT_BELOW_FLOOR')
  if (entry.missingDimensions.length > 0) reasons.push('DIMENSION_UNSCORED')
  // Only when no stronger statement already covers it — "a whole dimension is missing" makes
  // "some criteria are missing" redundant noise.
  else if (entry.partial) reasons.push('PARTIAL_EVIDENCE')

  return reasons
}
