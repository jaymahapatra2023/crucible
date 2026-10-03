/**
 * Comparing the two approaches on one golden set.
 *
 * The question the committee asked: if the scoring criteria have not been validated against human
 * judgement, is one undecomposed model judgement better? This computes the answer the only way it
 * can be computed — both approaches ranked over the same repositories, each correlated against the
 * committee's hand ranking.
 *
 * Three figures, and the third is the one people forget to ask for:
 *   - how closely the per-criterion ranking tracks the humans;
 *   - how closely the holistic ranking tracks the humans;
 *   - how closely each tracks ITSELF across two passes, because an approach that outranks the
 *     other on one run and not the next has not outranked it.
 */
import { averageRanks, spearman, type Correlation } from '@crucible/scoring'
import { AppError } from '../../../lib/appError.js'
import { selectRankings } from '../db/calibrationDb.js'
import { consensusRanking } from './calibrationReport.js'
import { selectCompositesFor, selectHolistic, selectSetSubjects } from '../db/holisticDb.js'

export interface ApproachRanking {
  approach: 'per-criterion' | 'holistic'
  /** Entry label → rank, 1 best. Null-scored entries are ranked last, and counted as such. */
  rows: Array<{ entryId: number; label: string; rank: number; score: number | null; note: string }>
  unscored: number
}

/** Rank descending by score; anything unscored goes last, which is a judgement the caller sees. */
function rankByScore(
  items: Array<{ entryId: number; label: string; score: number | null; note: string }>,
): ApproachRanking['rows'] {
  const scored = items.filter((i) => i.score !== null)
  const unscored = items.filter((i) => i.score === null)
  // averageRanks gives tied scores the same rank rather than an arbitrary order.
  const ranks = averageRanks(scored.map((i) => -(i.score as number)))
  const out = scored.map((item, index) => ({ ...item, rank: ranks[index] as number }))
  const after = scored.length
  return [...out, ...unscored.map((item, i) => ({ ...item, rank: after + i + 1 }))]
    .sort((a, b) => a.rank - b.rank)
}

export interface Comparison {
  goldenSetId: number
  entries: number
  perCriterion: ApproachRanking
  holistic: ApproachRanking
  /** Null until the hand rankings are in; the comparison is not decidable before then. */
  versusHumans: {
    perCriterion: Correlation
    holistic: Correlation
    rankers: string[]
  } | null
  /** Each approach against itself across two runs or passes. */
  reproducibility: { perCriterion: Correlation; holistic: Correlation }
  /** How the two approaches rank relative to each other, with or without humans. */
  betweenApproaches: Correlation
  /** Where they disagree most, for a reader to adjudicate by eye. */
  widestGaps: Array<{ label: string; perCriterionRank: number; holisticRank: number; gap: number }>
}

export async function compareApproaches(input: {
  goldenSetId: number
  cohortKey: string
}): Promise<Comparison> {
  const subjects = await selectSetSubjects(input.goldenSetId)
  if (subjects.length === 0) {
    throw new AppError('PRECONDITION_FAILED',
      `Golden set ${input.goldenSetId} has no linked submission to compare.`)
  }
  const ids = subjects.map((s) => s.submission_id)

  const [composites1, composites2, holistic1, holistic2] = await Promise.all([
    selectCompositesFor(ids, input.cohortKey, 1),
    selectCompositesFor(ids, input.cohortKey, 2),
    selectHolistic(input.goldenSetId, 1),
    selectHolistic(input.goldenSetId, 2),
  ])

  const perCriterionItems = (rows: typeof composites1) => subjects.map((s) => {
    const row = rows.find((r) => r.submission_id === s.submission_id)
    return {
      entryId: s.entry_id, label: s.label,
      score: row ? Number(row.composite) : null,
      note: row ? `composite ${Number(row.composite).toFixed(1)}` : 'not in this ranking',
    }
  })
  const holisticItems = (rows: typeof holistic1) => subjects.map((s) => {
    const row = rows.find((r) => r.submission_id === s.submission_id)
    return {
      entryId: s.entry_id, label: s.label,
      score: row?.overall ?? null,
      note: row?.overall !== null && row?.overall !== undefined
        ? `${row.overall}/100`
        : row?.non_score ?? 'not evaluated',
    }
  })

  const pc1 = rankByScore(perCriterionItems(composites1))
  const pc2 = rankByScore(perCriterionItems(composites2))
  const h1 = rankByScore(holisticItems(holistic1))
  const h2 = rankByScore(holisticItems(holistic2))

  const perCriterion: ApproachRanking = {
    approach: 'per-criterion', rows: pc1, unscored: pc1.filter((r) => r.score === null).length,
  }
  const holisticRanking: ApproachRanking = {
    approach: 'holistic', rows: h1, unscored: h1.filter((r) => r.score === null).length,
  }

  const alignedRanks = (a: ApproachRanking['rows'], b: ApproachRanking['rows']) => {
    const bByEntry = new Map(b.map((r) => [r.entryId, r.rank]))
    const shared = a.filter((r) => bByEntry.has(r.entryId))
    return {
      left: shared.map((r) => r.rank),
      right: shared.map((r) => bByEntry.get(r.entryId) as number),
    }
  }

  const between = alignedRanks(pc1, h1)
  const repPc = alignedRanks(pc1, pc2)
  const repH = alignedRanks(h1, h2)

  const humanRows = await selectRankings(input.goldenSetId)
  const rankers = [...new Set(humanRows.map((r) => r.ranker))]
  let versusHumans: Comparison['versusHumans'] = null
  if (rankers.length >= 2) {
    const consensus = consensusRanking(
      humanRows.map((r) => ({ entry_id: r.entry_id, ranker: r.ranker, position: r.position })),
      subjects.map((s) => s.entry_id))
    const asRows = consensus.map((c) => ({
      entryId: Number(c.entryId), label: '', rank: c.rank, score: 0, note: '',
    }))
    const vPc = alignedRanks(asRows, pc1)
    const vH = alignedRanks(asRows, h1)
    versusHumans = {
      perCriterion: spearman(vPc.left, vPc.right),
      holistic: spearman(vH.left, vH.right),
      rankers,
    }
  }

  const holisticRankByEntry = new Map(h1.map((r) => [r.entryId, r.rank]))
  const widestGaps = pc1
    .map((r) => ({
      label: r.label,
      perCriterionRank: r.rank,
      holisticRank: holisticRankByEntry.get(r.entryId) ?? 0,
      gap: Math.abs(r.rank - (holisticRankByEntry.get(r.entryId) ?? r.rank)),
    }))
    .filter((r) => r.gap > 0)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 5)

  return {
    goldenSetId: input.goldenSetId,
    entries: subjects.length,
    perCriterion,
    holistic: holisticRanking,
    versusHumans,
    reproducibility: {
      perCriterion: spearman(repPc.left, repPc.right),
      holistic: spearman(repH.left, repH.right),
    },
    betweenApproaches: spearman(between.left, between.right),
    widestGaps,
  }
}
