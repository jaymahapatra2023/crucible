/**
 * The challenge breakdown of the shortlist (E07-S05).
 *
 * The story's reasoning is the whole design: "a lopsided result is a visible decision rather
 * than an accident". An imbalanced shortlist is not necessarily wrong — one challenge may simply
 * have attracted better work — so this raises an ADVISORY and never blocks.
 *
 * The median composite per challenge sits alongside it for a specific reason (acceptance 3). If
 * one challenge holds most of the shortlist AND its median is much higher, the likely story is
 * that its submissions were stronger. If it holds most of the shortlist while its median is
 * comparable, the likely story is that its brief was easier to score well against — which is a
 * problem with the rubric, not with the teams. The two numbers together distinguish difficulty
 * imbalance from talent distribution; either alone cannot.
 */
import { AppError } from '../../../lib/appError.js'
import { getNumber } from '../../platform/services/configService.js'
import { selectCohorts } from '../db/rankingDb.js'
import { selectRanking, selectSnapshot } from '../db/rankingDb.js'

export interface ChallengeSplit {
  challengeId: number
  /** Submissions from this challenge inside the shortlist. */
  inShortlist: number
  shareOfShortlistPct: number
  /** Everything the run ranked for this challenge, shortlisted or not. */
  ranked: number
  cohortSize: number
  belowFloor: boolean
  /** Median composite across all ranked submissions in this challenge (acceptance 3). */
  medianComposite: number | null
  /** Median across only those in the shortlist, for the same comparison at the top. */
  medianShortlisted: number | null
  bestRank: number | null
}

export interface SplitReport {
  runIndexId: number
  shortlistSize: number
  /** Actual size, which is smaller than the configured one when the run ranked fewer. */
  shortlisted: number
  byChallenge: ChallengeSplit[]
  /** Non-blocking (acceptance 2). Null when the split is within the configured tolerance. */
  advisory: string | null
  imbalanceThresholdPct: number
}

export async function splitReport(runIndexId: number): Promise<SplitReport> {
  const snapshot = await selectSnapshot(runIndexId)
  if (!snapshot) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Scoring run ${runIndexId} has no stored ranking. Compute the ranking before asking how ` +
        `the shortlist splits across challenges.`,
    )
  }

  const [shortlistSize, thresholdPct] = await Promise.all([
    getNumber('scoring.shortlist_size'),
    getNumber('scoring.challenge_imbalance_pct'),
  ])

  const ranked = await selectRanking(runIndexId)
  const cohorts = new Map((await selectCohorts(runIndexId)).map((c) => [c.challenge_id, c]))
  const shortlist = ranked.filter((r) => r.rank_global <= shortlistSize)

  const challengeIds = [...new Set(ranked.map((r) => r.challenge_id))].sort((a, b) => a - b)

  const byChallenge: ChallengeSplit[] = challengeIds.map((challengeId) => {
    const all = ranked.filter((r) => r.challenge_id === challengeId)
    const top = shortlist.filter((r) => r.challenge_id === challengeId)
    const cohort = cohorts.get(challengeId)

    return {
      challengeId,
      inShortlist: top.length,
      shareOfShortlistPct: shortlist.length === 0
        ? 0
        : round1((top.length / shortlist.length) * 100),
      ranked: all.length,
      cohortSize: cohort?.cohort_size ?? all.length,
      belowFloor: cohort?.below_floor ?? false,
      medianComposite: median(all.map((r) => Number(r.composite))),
      medianShortlisted: median(top.map((r) => Number(r.composite))),
      bestRank: all.length === 0 ? null : Math.min(...all.map((r) => r.rank_global)),
    }
  })

  return {
    runIndexId,
    shortlistSize,
    shortlisted: shortlist.length,
    byChallenge,
    advisory: advisoryFor(byChallenge, thresholdPct),
    imbalanceThresholdPct: thresholdPct,
  }
}

/**
 * The advisory, written so it cannot be read as an instruction.
 *
 * It names the imbalance, gives the medians that bear on it, and says what each reading would
 * mean — then stops. Recommending an action here would be the system deciding, which is exactly
 * what P0 forbids.
 */
function advisoryFor(splits: readonly ChallengeSplit[], thresholdPct: number): string | null {
  if (splits.length < 2) return null

  const dominant = [...splits].sort((a, b) => b.shareOfShortlistPct - a.shareOfShortlistPct)[0]
  if (!dominant || dominant.shareOfShortlistPct <= thresholdPct) return null

  const others = splits.filter((s) => s.challengeId !== dominant.challengeId)
  const otherMedian = median(
    others.map((s) => s.medianComposite).filter((m): m is number => m !== null))

  const comparison = dominant.medianComposite === null || otherMedian === null
    ? 'Median composites are not available for comparison.'
    : dominant.medianComposite - otherMedian >= 5
      ? `Its median composite (${dominant.medianComposite}) is also higher than the other ` +
        `challenges' (${otherMedian}), which is what a genuinely stronger field looks like.`
      : `Its median composite (${dominant.medianComposite}) is close to the other challenges' ` +
        `(${otherMedian}), so the split is unlikely to be explained by stronger work alone — ` +
        `it may be easier to score well against this brief.`

  return `Challenge ${dominant.challengeId} holds ${dominant.shareOfShortlistPct}% of the ` +
    `shortlist, above the ${thresholdPct}% advisory threshold. ${comparison} This is an ` +
    `observation for the organisers, not a problem the system can resolve.`
}

/** The middle value, averaging the two middles for an even count. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return round1(sorted.length % 2 === 1
    ? sorted[middle]!
    : ((sorted[middle - 1]! + sorted[middle]!) / 2))
}

const round1 = (n: number): number => Math.round(n * 10) / 10
