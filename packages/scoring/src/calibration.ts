/**
 * Comparing machine ranking against human judgement (E11-S02).
 *
 * This is the arithmetic the go/no-go decision rests on, so it is deliberately conservative
 * about what it claims. Three things follow:
 *
 *  - **Spearman, not Pearson.** The question is whether the machine puts teams in the same
 *    ORDER as a person, not whether its composites track their scores linearly. Nobody
 *    hand-scores a repository 73.4.
 *  - **A correlation is reported with its sample size, always.** Eight repositories is a small
 *    set — correct for calibration, and far too small for a coefficient to be read without it.
 *    ρ = 0.8 over eight items is a different statement from ρ = 0.8 over eighty.
 *  - **Disagreements are listed individually.** A single coefficient cannot distinguish "close
 *    everywhere" from "right about seven and catastrophically wrong about the eighth", and it
 *    is the eighth that decides whether this system should be used.
 */

export interface RankedEntry {
  entryId: string
  /** 1 is best. Ties share the lower rank, as `averageRanks` assigns them. */
  rank: number
}

/**
 * Fractional ranks, with ties averaged.
 *
 * Two repositories a human could not separate should not be forced into an arbitrary order; the
 * midpoint keeps them equal, which is what the human actually said.
 */
export function averageRanks(values: readonly number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value)

  const ranks = new Array<number>(values.length)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1]!.value === indexed[i]!.value) j++
    const shared = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[indexed[k]!.index] = shared
    i = j + 1
  }
  return ranks
}

export interface Correlation {
  /** Spearman's ρ in [-1, 1], or null when it cannot be computed. */
  rho: number | null
  n: number
  /** Why ρ is null, in words — never left for the caller to infer. */
  note: string | null
}

/**
 * Spearman rank correlation between two orderings of the same items.
 *
 * Returns null rather than a number whenever the figure would be meaningless: fewer than three
 * items, or one side ranking everything equally. A coefficient computed from two items is always
 * ±1 and says nothing at all.
 */
export function spearman(a: readonly number[], b: readonly number[]): Correlation {
  if (a.length !== b.length) {
    return { rho: null, n: 0, note: 'The two rankings cover different numbers of items.' }
  }
  if (a.length < 3) {
    return {
      rho: null, n: a.length,
      note: `A rank correlation over ${a.length} item(s) is not meaningful — with two items it ` +
        `is always +1 or -1, whatever the rankings mean.`,
    }
  }

  const ra = averageRanks(a)
  const rb = averageRanks(b)
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  const ma = mean(ra)
  const mb = mean(rb)

  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < ra.length; i++) {
    const da = ra[i]! - ma
    const db = rb[i]! - mb
    cov += da * db
    va += da * da
    vb += db * db
  }

  if (va === 0 || vb === 0) {
    return {
      rho: null, n: a.length,
      note: 'One of the rankings places every item equally, so there is no order to correlate.',
    }
  }

  return { rho: round3(cov / Math.sqrt(va * vb)), n: a.length, note: null }
}

export interface Disagreement {
  entryId: string
  humanRank: number
  machineRank: number
  /** Positive means the machine ranked it WORSE than the human did. */
  delta: number
  material: boolean
}

/**
 * Where the two orderings differ, and by how much.
 *
 * "Material" is a threshold on the rank gap rather than on the composite: a gap of one place
 * near the top of eight is noise, and a gap of five is the machine and the human disagreeing
 * about what good work looks like.
 */
export function disagreements(
  human: readonly RankedEntry[],
  machine: readonly RankedEntry[],
  materialGap: number,
): Disagreement[] {
  const machineByEntry = new Map(machine.map((m) => [m.entryId, m.rank]))

  return human
    .filter((h) => machineByEntry.has(h.entryId))
    .map((h) => {
      const machineRank = machineByEntry.get(h.entryId)!
      const delta = machineRank - h.rank
      return {
        entryId: h.entryId,
        humanRank: h.rank,
        machineRank,
        delta,
        material: Math.abs(delta) >= materialGap,
      }
    })
    // Largest disagreement first: the list is read from the top and the tail is skimmed.
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
}

export interface DimensionAgreement {
  dimension: string
  correlation: Correlation
}

/**
 * Which dimension's ordering least resembles the human ordering (E11-S02 acceptance 3).
 *
 * Each dimension is correlated against the human ranking on its own. A dimension that correlates
 * badly while the composite correlates well is the one carrying the disagreement — and it is
 * usually more useful to know that than to know the composite is 0.72.
 */
export function dimensionAgreement(
  humanRanks: readonly number[],
  byDimension: Readonly<Record<string, readonly number[]>>,
): DimensionAgreement[] {
  return Object.entries(byDimension)
    .map(([dimension, scores]) => ({
      dimension,
      // Negated: a HIGH score should correspond to a LOW (better) rank, so correlating the
      // raw score against the rank would invert the sign of every sound dimension.
      correlation: spearman(humanRanks, scores.map((s) => -s)),
    }))
    .sort((a, b) => (a.correlation.rho ?? 1) - (b.correlation.rho ?? 1))
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

/**
 * How much the human rankers agree with EACH OTHER.
 *
 * This is the denominator the machine-versus-human figure is read against, and without it that
 * figure cannot be interpreted at all. A ρ of 0.61 between the machine and a consensus means one
 * thing when the people behind that consensus agree at 0.95, and something entirely different
 * when they agree at 0.45 — in the second case there is no stable human ordering to correlate
 * against, and the machine is being marked against noise.
 *
 * Reported as **every pair**, not an average, so one outlying rater is visible rather than
 * smoothed away. `lowest` is the binding constraint: a consensus is only as trustworthy as its
 * least-agreeing pair.
 *
 * One ranker gives `null`, never 1.0. A single person agrees with themselves by construction,
 * and reporting that as perfect agreement would be the most misleading number in the report.
 */
export interface RaterPair {
  a: string
  b: string
  rho: number | null
  /** Entries both of them ranked. A pair with no overlap is reported, not dropped. */
  n: number
}

export type AgreementStrength = 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG'

export interface RaterAgreement {
  rankers: string[]
  pairs: RaterPair[]
  lowest: number | null
  mean: number | null
  strength: AgreementStrength
  /**
   * Whether the agreement is too close to be taken at face value.
   *
   * A flag rather than a caller reading it out of `note`: prose is for people, and a decision
   * taken by matching on a sentence breaks the first time the sentence is reworded.
   */
  independenceQuestioned: boolean
  note: string
}

/** Below this there is no shared human ordering worth correlating a machine against. */
const WEAK_BELOW = 0.5
/** Below this the consensus is usable but the machine's figure carries real slack. */
const MODERATE_BELOW = 0.7
/**
 * At or above this, with only two rankers, the likelier explanation is that the two rankings
 * were not arrived at independently. Raised as a QUESTION, never as a finding: two people reading
 * eleven repositories really can land this close, and the report cannot tell the difference.
 */
const IMPLAUSIBLY_HIGH = 0.95

export function interRaterAgreement(
  rows: ReadonlyArray<{ entryId: string; ranker: string; position: number }>,
): RaterAgreement {
  const byRanker = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const positions = byRanker.get(row.ranker) ?? new Map<string, number>()
    positions.set(row.entryId, row.position)
    byRanker.set(row.ranker, positions)
  }

  const rankers = [...byRanker.keys()].sort()
  if (rankers.length < 2) {
    return {
      rankers, pairs: [], lowest: null, mean: null, strength: 'NONE',
      independenceQuestioned: false,
      note: rankers.length === 0
        ? 'Nobody has ranked this set by hand, so there is no human ordering to compare against.'
        : `Only ${rankers[0]} has ranked this set. One person's ranking has no agreement to `
          + `measure, so the machine's correlation cannot be told apart from agreement with one `
          + `reader's taste.`,
    }
  }

  const pairs: RaterPair[] = []
  for (let i = 0; i < rankers.length; i++) {
    for (let j = i + 1; j < rankers.length; j++) {
      const a = rankers[i]!
      const b = rankers[j]!
      const pa = byRanker.get(a)!
      const pb = byRanker.get(b)!
      const shared = [...pa.keys()].filter((entryId) => pb.has(entryId)).sort()
      const result = spearman(
        shared.map((entryId) => pa.get(entryId)!),
        shared.map((entryId) => pb.get(entryId)!),
      )
      pairs.push({ a, b, rho: result.rho, n: result.n })
    }
  }

  const computed = pairs.map((p) => p.rho).filter((rho): rho is number => rho !== null)
  if (computed.length === 0) {
    return {
      rankers, pairs, lowest: null, mean: null, strength: 'NONE',
      independenceQuestioned: false,
      note: 'No pair of rankers overlaps on enough entries for their agreement to be computed.',
    }
  }

  const lowest = Math.min(...computed)
  const mean = computed.reduce((sum, rho) => sum + rho, 0) / computed.length
  const strength: AgreementStrength =
    lowest < WEAK_BELOW ? 'WEAK' : lowest < MODERATE_BELOW ? 'MODERATE' : 'STRONG'

  const independenceQuestioned =
    strength === 'STRONG' && lowest >= IMPLAUSIBLY_HIGH && rankers.length === 2

  return {
    rankers, pairs, lowest, mean, strength, independenceQuestioned,
    note: describe(strength, lowest, rankers),
  }
}

function describe(
  strength: AgreementStrength, lowest: number, rankers: readonly string[],
): string {
  const who = `${rankers.length} rankers`
  const rho = lowest.toFixed(3)

  if (strength === 'WEAK') {
    return `${who}, and the least-agreeing pair is at ρ ${rho}. They do not share an ordering, `
      + `so there is no stable human judgement here for the machine to be measured against — a `
      + `low machine correlation against this consensus is not evidence the machine is wrong. `
      + `Either the dimension is not judgeable this way, or the rankers read the question `
      + `differently.`
  }
  if (strength === 'MODERATE') {
    return `${who}, and the least-agreeing pair is at ρ ${rho} — a usable consensus, but the `
      + `machine's figure carries at least this much slack. Read a shortfall against the gate `
      + `threshold in that light.`
  }
  if (lowest >= IMPLAUSIBLY_HIGH && rankers.length === 2) {
    return `Two rankers at ρ ${rho}. That is high enough to be worth asking whether the two `
      + `rankings were arrived at independently — if one was derived from the other, or both `
      + `from the same source, the consensus is one opinion and the agreement figure is an `
      + `artefact rather than evidence.`
  }
  return `${who}, and the least-agreeing pair is at ρ ${rho}. The consensus rests on a shared `
    + `ordering, so the machine's correlation against it can be read at face value.`
}
