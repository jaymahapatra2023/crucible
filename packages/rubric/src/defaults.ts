/**
 * Default dimension weights (plan §II.4).
 *
 * This is the starting template the generator fills in and the committee adjusts — a default,
 * never a constant. The committee sets the real weights during E02-S06, and whatever they set is
 * what the frozen rubric carries.
 */
import { DIMENSIONS, type DimensionWeights } from './types.js'

export const DEFAULT_DIMENSION_WEIGHTS: DimensionWeights = {
  /** Generated per challenge; normalised within its own cohort before entering the composite. */
  CHALLENGE_FIDELITY: 0.30,
  ENGINEERING_QUALITY: 0.25,
  PRINCIPLES_STANDARDS: 0.20,
  /** Objective — derived from the build probe, never model-scored. */
  RUNS: 0.15,
  /** Advisory only, and the lowest weight by design. */
  ORIGINALITY: 0.10,
}

/** Tolerance for weight sums. Exact float equality to 1.0 is not achievable or meaningful. */
export const WEIGHT_TOLERANCE = 1e-6

/** Weights are stored to this precision so a hash is reproducible across environments. */
export const WEIGHT_PRECISION = 6

export function roundWeight(w: number): number {
  const factor = 10 ** WEIGHT_PRECISION
  return Math.round(w * factor) / factor
}

export function sumsToOne(values: readonly number[]): boolean {
  if (values.length === 0) return false
  const total = values.reduce((a, b) => a + b, 0)
  return Math.abs(total - 1) <= WEIGHT_TOLERANCE
}

/**
 * Rescale weights so they sum to 1.0, preserving their relative proportions.
 *
 * Offered as an explicit helper for the review UI's "normalise" action — it is never applied
 * silently. E02-S06 requires a human to set weights and the UI to *block* approval until each
 * dimension sums to 1.0; quietly rescaling behind their back would defeat that.
 */
export function rescaleToOne(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    const even = roundWeight(1 / values.length)
    return values.map(() => even)
  }
  const scaled = values.map((v) => roundWeight(v / total))
  // Put any rounding residue on the largest weight, so the result sums to exactly 1.0.
  const residue = roundWeight(1 - scaled.reduce((a, b) => a + b, 0))
  if (residue !== 0) {
    let maxIndex = 0
    for (let i = 1; i < scaled.length; i++) {
      if ((scaled[i] ?? 0) > (scaled[maxIndex] ?? 0)) maxIndex = i
    }
    scaled[maxIndex] = roundWeight((scaled[maxIndex] ?? 0) + residue)
  }
  return scaled
}

/** An even split across all five dimensions — used only as a fallback in tests and fixtures. */
export function evenDimensionWeights(): DimensionWeights {
  const each = roundWeight(1 / DIMENSIONS.length)
  return Object.fromEntries(DIMENSIONS.map((d) => [d, each])) as DimensionWeights
}
