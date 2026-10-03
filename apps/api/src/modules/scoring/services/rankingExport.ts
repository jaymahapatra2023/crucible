/**
 * The ranking as CSV (E07-S03 acceptance 3).
 *
 * "The fallback is visible in the UI and in the export — never silent." An export is where a
 * number is most likely to be detached from its caveats: it gets opened in a spreadsheet, sorted
 * by composite, and read as a league table. So every caveat travels in its own column rather
 * than in a footnote nobody exports — the normalisation method, the cohort size, whether the
 * cohort was below the floor, what share of the rubric could be scored, and which dimensions
 * could not be.
 *
 * `fidelity_raw` sits beside `fidelity_normalised` for the same reason it is persisted: only the
 * raw value answers "how well did they actually address the brief" (E07-S02 acceptance 3).
 */
import { REVIEW_REASON_TEXT, type ReviewReason } from '@crucible/scoring'
import { csvDocument } from '../../../lib/csv.js'
import { AppError } from '../../../lib/appError.js'
import { getNumber } from '../../platform/services/configService.js'
import { selectCohorts, selectRanking, selectSnapshot } from '../db/rankingDb.js'

const HEADER = [
  'rank_global', 'rank_in_challenge', 'submission_id', 'team_name', 'challenge_id',
  'composite', 'fidelity_raw', 'fidelity_normalised',
  'normalisation_method', 'cohort_size', 'cohort_below_floor',
  'weight_covered_pct', 'dimensions_not_scored', 'partial',
  'tied', 'in_cut_band', 'position_depends_on_advisory', 'requires_review', 'review_reasons',
  'within_shortlist', 'computed_at',
] as const

export async function exportRanking(runIndexId: number): Promise<string> {
  const snapshot = await selectSnapshot(runIndexId)
  if (!snapshot) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Scoring run ${runIndexId} has no stored ranking to export.`,
    )
  }

  const shortlistSize = await getNumber('scoring.shortlist_size')
  const ranked = await selectRanking(runIndexId)
  const belowFloor = new Set(
    (await selectCohorts(runIndexId)).filter((c) => c.below_floor).map((c) => c.challenge_id))

  return csvDocument(HEADER, ranked.map((r) => [
    r.rank_global,
    r.rank_in_challenge,
    r.submission_id,
    r.team_name ?? '',
    r.challenge_id,
    r.composite,
    // Empty rather than 0: fidelity that was never scored has no value, and a zero in a
    // spreadsheet column is indistinguishable from a team that scored nothing.
    r.fidelity_raw ?? '',
    r.fidelity_normalised ?? '',
    r.normalisation_method,
    r.cohort_size,
    belowFloor.has(r.challenge_id) ? 'YES' : 'no',
    Math.round(Number(r.weight_covered) * 100),
    r.missing_dimensions.join(' '),
    r.partial ? 'YES' : 'no',
    r.tied ? 'YES' : 'no',
    r.in_cut_band ? 'YES' : 'no',
    r.advisory_decided ? 'YES' : 'no',
    r.requires_review ? 'YES' : 'no',
    // Spelled out rather than coded: a spreadsheet is read without the schema beside it.
    r.review_reasons.map((code) => REVIEW_REASON_TEXT[code as ReviewReason] ?? code).join('; '),
    // Not "selected". Within the review list, which is a different claim (E07-S04 acceptance 3).
    r.rank_global <= shortlistSize ? 'YES' : 'no',
    r.computed_at.toISOString(),
  ]))
}
