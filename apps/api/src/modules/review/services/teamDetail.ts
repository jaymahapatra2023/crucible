/**
 * Everything known about one team, assembled for review (E08-S02).
 *
 * The story lists five things, and the fifth is the one that does not exist anywhere else:
 * "Both runs' scores shown side by side where they differ." Crucible scores every cohort twice
 * precisely so disagreement is visible, and a detail view that showed one run would quietly
 * discard the evidence that the double run exists to produce.
 *
 * Only criteria where the two runs DIFFER are paired up. Listing every criterion twice would
 * bury the handful that disagree in a wall of identical rows, which is how a real signal gets
 * lost in a complete one.
 */
import { AppError } from '../../../lib/appError.js'
import { logistics } from '../../../lib/ports/logisticsPort.js'
import { query } from '../../../db/pool.js'
import { selectScoreRun, selectRunsForCohort, selectScoresFor } from '../../scoring/db/scoringDb.js'
import { selectDimensionScores, selectRanking } from '../../scoring/db/rankingDb.js'
import { selectFlags } from '../db/flagDb.js'
import { selectDecisions } from '../db/shortlistDb.js'
import { probesFor, provenanceFor } from '../db/sourceDb.js'

export interface RunDifference {
  criterionId: number
  dimension: string
  runA: { runIndex: number; rawScore: number | null; nonScore: string | null; rationale: string }
  runB: { runIndex: number; rawScore: number | null; nonScore: string | null; rationale: string }
}

export async function teamDetail(runIndexId: number, submissionId: number) {
  const run = await selectScoreRun(runIndexId)
  if (!run) throw new AppError('NOT_FOUND', `Scoring run ${runIndexId} was not found.`)

  const [ranked, scores, dimensions, flags, decisions, probes, provenance, submission] =
    await Promise.all([
      selectRanking(runIndexId),
      selectScoresFor(runIndexId, submissionId),
      selectDimensionScores(runIndexId, submissionId),
      selectFlags(runIndexId, submissionId),
      selectDecisions(runIndexId),
      probesFor([submissionId]),
      provenanceFor([submissionId]),
      submissionSummary(submissionId),
    ])

  return {
    submission,
    // Where they sat and who coached them (E27-S03 acceptance 4). A reviewer answering an appeal
    // is often reconstructing the day, and "which room were they in" is part of it. Null when the
    // roster never placed them — this page does not invent a fact to fill a field.
    place: submission === null ? null : await teamPlace(submission.team_id),
    ranking: ranked.find((r) => r.submission_id === submissionId) ?? null,
    dimensions,
    criteria: scores,
    flags,
    decision: decisions.find((d) => d.submission_id === submissionId) ?? null,
    probe: probes.get(submissionId) ?? null,
    // The observations themselves. The conclusion a person reached about them lives in the
    // appeal packet and the provenance queue — this page shows what was seen, not who has
    // since looked at it.
    provenance: provenance.get(submissionId)?.flags ?? [],
    runDifferences: await runDifferences(run.cohort_key, runIndexId, submissionId),
  }
}

/** Repository link and team identity (acceptance 2), from the published view (P1.3). */
async function submissionSummary(submissionId: number) {
  const res = await query<{
    submission_id: number; team_name: string; team_id: number | null; challenge_id: number
    repo_url: string; build_method: string; locked_commit_sha: string | null
  }>(
    `SELECT submission_id, team_name, team_id, challenge_id, repo_url, build_method,
            locked_commit_sha
       FROM v_submissions_submission WHERE submission_id = $1`,
    [submissionId])
  return res.rows[0] ?? null
}

/** Through the port: rooms and coaches are the roster's, not review's (ADR 0002). */
async function teamPlace(teamId: number | null) {
  if (teamId === null) return null
  return (await logistics().forTeams([teamId])).get(teamId) ?? null
}

/**
 * Criteria the two runs scored differently (acceptance 5).
 *
 * Returns an empty list when the cohort's second run has not happened, which is honest: "the
 * runs agree" and "there is only one run" are different statements, and the caller distinguishes
 * them by whether a second run exists at all.
 */
async function runDifferences(
  cohortKey: string, runIndexId: number, submissionId: number,
): Promise<RunDifference[]> {
  const runs = await selectRunsForCohort(cohortKey)
  const other = runs.find((r) => r.run_index_id !== runIndexId)
  if (!other) return []

  const [mine, theirs] = await Promise.all([
    selectScoresFor(runIndexId, submissionId),
    selectScoresFor(other.run_index_id, submissionId),
  ])

  const thisRun = runs.find((r) => r.run_index_id === runIndexId)
  const byCriterion = new Map(theirs.map((s) => [s.criterion_id, s]))
  const differences: RunDifference[] = []

  for (const score of mine) {
    const counterpart = byCriterion.get(score.criterion_id)
    if (!counterpart) continue
    // A difference in EITHER the score or the non-score reason: "scored 3" versus "could not be
    // evidenced" is a disagreement about the work, even though neither is a number.
    if (score.raw_score === counterpart.raw_score
      && score.non_score === counterpart.non_score) continue

    differences.push({
      criterionId: score.criterion_id,
      dimension: score.dimension,
      runA: {
        runIndex: thisRun?.run_index ?? 0,
        rawScore: score.raw_score, nonScore: score.non_score, rationale: score.rationale,
      },
      runB: {
        runIndex: other.run_index,
        rawScore: counterpart.raw_score, nonScore: counterpart.non_score,
        rationale: counterpart.rationale,
      },
    })
  }

  return differences
}
