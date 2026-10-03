/**
 * How much of a cohort was described, and whether it was described evenly (E15-S04).
 *
 * The question is not "how many were discovered" but "were they all treated alike".
 *
 * Discovery feeds the principles and standards evaluators. A cohort where NOBODY was discovered
 * is consistent, and therefore fair — every submission was judged on the same evidence. A cohort
 * where some were and some were not is neither: those submissions were scored against the same
 * rubric, in the same ranking, on unequal context, and nothing on screen said so.
 *
 * That is the failure this read model exists to make impossible to ship.
 */
import { query } from '../../../db/pool.js'

export type CoverageState = 'NONE' | 'PARTIAL' | 'COMPLETE'

export interface DiscoveryCoverage {
  submissions: number
  discovered: number
  completed: number
  undiscovered: number
  state: CoverageState
  /** True only for PARTIAL: the one state that makes a ranking unfair rather than merely thin. */
  uneven: boolean
  note: string
}

/**
 * Coverage across a given set of submissions.
 *
 * The caller supplies the ids — the ranking module knows which submissions a run ordered, and
 * this module knows which of them were described. Reading `criterion_score` from here would be
 * a cross-module table read (P1.3): a join that works today and breaks the moment scoring
 * reshapes a table it owns and nobody thinks to look in the discovery module.
 */
export async function coverageFor(
  submissionIds: readonly number[],
): Promise<DiscoveryCoverage> {
  if (submissionIds.length === 0) return describe(0, 0, 0)

  const res = await query<{ discovered: number; completed: number }>(
    `SELECT COUNT(*)::int AS discovered,
            COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
       FROM v_discovery_current
      WHERE submission_id = ANY($1::bigint[])`,
    [submissionIds])

  const row = res.rows[0] ?? { discovered: 0, completed: 0 }
  return describe(submissionIds.length, row.discovered, row.completed)
}

export function describe(
  submissions: number, discovered: number, completed: number,
): DiscoveryCoverage {
  const undiscovered = submissions - discovered
  const state: CoverageState = discovered === 0 ? 'NONE'
    : undiscovered === 0 ? 'COMPLETE' : 'PARTIAL'

  return {
    submissions, discovered, completed, undiscovered,
    state,
    uneven: state === 'PARTIAL',
    note: noteFor(state, submissions, discovered, undiscovered),
  }
}

function noteFor(
  state: CoverageState, submissions: number, discovered: number, undiscovered: number,
): string {
  if (submissions === 0) return 'Nothing has been scored in this run yet.'

  switch (state) {
    case 'NONE':
      // Consistent, and therefore fair. Warning here would train an operator to ignore the
      // warning that matters.
      return 'No submission in this run was described by discovery, so every one was judged on '
        + 'the same evidence.'
    case 'COMPLETE':
      return `All ${submissions} submissions were described before scoring.`
    case 'PARTIAL':
      return `Only ${discovered} of ${submissions} submissions were described before scoring. `
        + `The other ${undiscovered} were judged on less context than their competitors, against `
        + `the same rubric and in the same ranking. Discover the remaining ${undiscovered} and `
        + `re-score, or treat this ranking as provisional.`
  }
}
