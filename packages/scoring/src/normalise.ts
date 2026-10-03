/**
 * Within-cohort normalisation of challenge fidelity (E07-S02, E07-S03).
 *
 * Finding F5 makes a single global ranking valid by normalising fidelity *within its own
 * challenge cohort* before it enters the composite — so the dimension reads "how well did you
 * solve the challenge you chose", which means the same thing on both tracks.
 *
 * Deterministic and unit-tested on degenerate cohorts (acceptance 2), because degenerate cohorts
 * are where a normalisation quietly produces nonsense: all-equal scores, a single team, a cohort
 * of two.
 */

export interface NormalisationResult {
  /** Normalised 0–100 standing within the cohort. */
  normalised: number
  /** The raw score, always preserved for appeals (acceptance 3). */
  raw: number
  cohortSize: number
  method: 'PERCENTILE' | 'ABSOLUTE_FALLBACK' | 'DEGENERATE_UNIFORM'
  /** Set when the transform could not distinguish submissions, so a reader is not misled. */
  note: string | null
}

/**
 * Percentile standing within the cohort.
 *
 * A percentile rather than a z-score: a z-score assumes a distribution shape that fifteen
 * hackathon submissions cannot support, and produces unbounded values that then need clamping
 * anyway. The midpoint convention (counting ties as half) keeps tied submissions equal, which a
 * strict "less than" rule would not.
 */
export function percentileStanding(value: number, cohort: readonly number[]): number {
  if (cohort.length === 0) return 50
  let below = 0
  let equal = 0
  for (const other of cohort) {
    if (other < value) below++
    else if (other === value) equal++
  }
  return ((below + equal / 2) / cohort.length) * 100
}

export interface NormaliseOptions {
  /** Below this cohort size, fall back to absolute scoring (E07-S03 acceptance 2). */
  minCohortSize: number
}

export const DEFAULT_NORMALISE_OPTIONS: NormaliseOptions = { minCohortSize: 15 }

/**
 * Normalise one submission's fidelity against its cohort.
 *
 * Three guarded cases, each explicit rather than emergent:
 *
 *  - **Thin cohort** → absolute scoring, flagged. Normalising six submissions produces spacing
 *    that looks like signal and is not.
 *  - **All-equal cohort** → everyone keeps their raw score. A percentile would put every
 *    submission at 50 and erase a real, shared result.
 *  - **Otherwise** → percentile standing.
 */
export function normaliseFidelity(
  raw: number,
  cohort: readonly number[],
  options: NormaliseOptions = DEFAULT_NORMALISE_OPTIONS,
): NormalisationResult {
  const cohortSize = cohort.length

  if (cohortSize < options.minCohortSize) {
    return {
      normalised: raw,
      raw,
      cohortSize,
      method: 'ABSOLUTE_FALLBACK',
      note:
        `Cohort of ${cohortSize} is below the floor of ${options.minCohortSize}, so fidelity is ` +
        `scored absolutely. Normalising a cohort this small turns noise into apparent ranking. ` +
        `Every affected submission is flagged for human review.`,
    }
  }

  const allEqual = cohort.every((v) => v === cohort[0])
  if (allEqual) {
    return {
      normalised: raw,
      raw,
      cohortSize,
      method: 'DEGENERATE_UNIFORM',
      note:
        'Every submission in this cohort scored identically on fidelity, so normalisation ' +
        'would place all of them at the midpoint and erase a real shared result.',
    }
  }

  return {
    normalised: Math.round(percentileStanding(raw, cohort) * 1e6) / 1e6,
    raw,
    cohortSize,
    method: 'PERCENTILE',
    note: null,
  }
}
