/**
 * Scoring endpoints (E06-S02 … E06-S06).
 *
 * Note what is absent: there is no endpoint that selects, shortlists or eliminates anyone.
 * `/ranking` returns an ordering and `/variance` returns disagreements; both are reports for a
 * person to act on (P0 constraint 1).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { startRun } from '../services/scoreRunService.js'
import {
  computeVariance, dismissFlag, listOpenFlags, listVariance,
} from '../services/varianceService.js'
import { computeRanking, cutBandReport, storedRanking } from '../services/rankingService.js'
import { splitReport } from '../services/splitReport.js'
import { coverageFor } from '../../discovery/services/discoveryCoverage.js'
import { exportRanking } from '../services/rankingExport.js'
import { selectCohorts } from '../db/rankingDb.js'
import {
  listScoreRuns, scoringHealth, selectRunsForCohort, selectScoreRun, selectScoresFor,
} from '../db/scoringDb.js'
import {
  selectPrincipleAssessments, selectStandardAssessments,
} from '../db/principlesDb.js'
import { selectOriginality } from '../db/originalityDb.js'
import { persistedScan } from '../../scans/services/scanService.js'
import { describeMetrics } from '../services/submissionScorer.js'

const runParams = z.object({ id: z.coerce.number().int().min(1) })
const cohortParams = z.object({ cohortKey: z.string().min(1).max(200) })
const submissionQuery = z.object({ submissionId: z.coerce.number().int().min(1) })

const startBody = z.object({
  cohortKey: z.string().min(1).max(200),
  runIndex: z.union([z.literal(1), z.literal(2)]),
  submissionIds: z.array(z.number().int().min(1)).min(1).max(500),
  resume: z.boolean().default(false),
})

const dismissBody = z.object({
  submissionId: z.number().int().min(1),
  reason: z.string().trim().min(10).max(2000),
})

export async function registerScoringRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Start one of the two runs for a cohort.
   *
   * Organiser and above: a scoring run costs real money and produces the numbers a shortlist is
   * drawn from.
   */
  app.post('/api/v1/scoring/runs', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, startBody)
    const outcome = await startRun({
      cohortKey: input.cohortKey,
      runIndex: input.runIndex,
      submissionIds: input.submissionIds,
      resume: input.resume,
      startedBy: principalOf(req).email,
    })
    return ok({
      run: outcome.run,
      scored: outcome.summaries.length,
      failed: outcome.failedSubmissions,
      summaries: outcome.summaries,
    })
  })

  /** Every scoring run, so the review screens are reachable without knowing an id. */
  app.get('/api/v1/scoring/runs', { preHandler: requireRole('viewer') }, async () =>
    ok(await listScoreRuns()),
  )

  app.get('/api/v1/scoring/runs/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, runParams)
    const run = await selectScoreRun(id)
    if (!run) throw new AppError('NOT_FOUND', `Scoring run ${id} was not found.`)
    return ok({ run, health: await scoringHealth(id) })
  })

  /**
   * Everything recorded about one submission in one run.
   *
   * The appeal surface: criterion scores with their evidence, the principle and standard
   * assessments, and the advisory originality signal with the measurements behind it.
   */
  app.get('/api/v1/scoring/runs/:id/scores', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, runParams)
    const { submissionId } = query(req, submissionQuery)

    const [criteria, principles, standards, originality, metrics] = await Promise.all([
      selectScoresFor(id, submissionId),
      selectPrincipleAssessments(id, submissionId),
      selectStandardAssessments(id, submissionId),
      selectOriginality(id, submissionId),
      // E06-S04 acceptance 3: the metric inputs are shown beside the engineering score. Read
      // from the same persisted scan the scorer used, so the figures a reviewer sees are the
      // figures the score was computed from rather than a fresh measurement that may differ.
      metricInputs(submissionId),
    ])
    return ok({ criteria, principles, standards, originality, metrics })
  })

  /**
   * Compute and store the ranking (E07-S04 acceptance 1).
   *
   * A POST because it writes: the order a team was placed by is evidence, and evidence is
   * produced deliberately and kept, not re-derived differently on every read.
   */
  app.post('/api/v1/scoring/runs/:id/ranking', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, runParams)
    return ok(await computeRanking(id, principalOf(req).email))
  })

  /**
   * The stored ranking.
   *
   * Reports `stale` when criterion scores have been added since it was computed, rather than
   * quietly serving an out-of-date order as though it were current (P5.1).
   */
  app.get('/api/v1/scoring/runs/:id/ranking', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    if (!(await selectScoreRun(id))) {
      throw new AppError('NOT_FOUND', `Scoring run ${id} was not found.`)
    }

    const result = await storedRanking(id)
    if (result.snapshot === null) {
      throw new AppError(
        'PRECONDITION_FAILED',
        `Scoring run ${id} has no stored ranking yet. Compute it first — Crucible does not ` +
          `invent a ranking on read, because the order a team was placed by has to be the one ` +
          `that was recorded.`,
      )
    }

    return ok({
      ...result,
      partialCount: result.ranked.filter((r) => r.partial).length,
      // Whether this field was evidenced evenly (E15-S04). A ranking over a partially
      // discovered cohort orders submissions that were judged on unequal context, and that is
      // a property of the ranking rather than of any one submission in it.
      // The ids come from the ranking, which this module owns; discovery answers only about
      // its own tables (P1.3).
      discoveryCoverage: await coverageFor(result.ranked.map((r) => Number(r.submission_id))),
    })
  })

  /** The cohort sizes this run used, recorded before scoring (E07-S03 acceptance 1). */
  app.get('/api/v1/scoring/runs/:id/cohorts', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, runParams)
    return ok(await selectCohorts(id))
  })

  /** How the shortlist splits across challenges (E07-S05). */
  app.get('/api/v1/scoring/runs/:id/split', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    return ok(await splitReport(id))
  })

  /**
   * The ranking as CSV, caveats included (E07-S03 acceptance 3).
   *
   * Reviewer and above: the export carries team names beside their positions.
   */
  app.get('/api/v1/scoring/runs/:id/ranking.csv', { preHandler: requireRole('reviewer') }, async (req, reply) => {
    const { id } = params(req, runParams)
    const csv = await exportRanking(id)
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="ranking-run-${id}.csv"`)
      .send(csv)
  })

  /**
   * The cut-line band (E07-S06).
   *
   * Every submission listed requires review (acceptance 2), and those whose position turns on
   * the advisory inventiveness dimension are called out separately (acceptance 3).
   */
  app.get('/api/v1/scoring/runs/:id/borderline', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    return ok(await cutBandReport(id))
  })

  app.get('/api/v1/scoring/cohorts/:cohortKey/runs', { preHandler: requireRole('viewer') }, async (req) => {
    const { cohortKey } = params(req, cohortParams)
    return ok(await selectRunsForCohort(cohortKey))
  })

  /** Compute the comparison between the cohort's two runs (E06-S06). */
  app.post('/api/v1/scoring/cohorts/:cohortKey/variance', { preHandler: requireRole('organiser') }, async (req) => {
    const { cohortKey } = params(req, cohortParams)
    return ok(await computeVariance(cohortKey))
  })

  app.get('/api/v1/scoring/cohorts/:cohortKey/variance', { preHandler: requireRole('reviewer') }, async (req) => {
    const { cohortKey } = params(req, cohortParams)
    const [all, open] = await Promise.all([listVariance(cohortKey), listOpenFlags(cohortKey)])
    return ok({ all, open, openCount: open.length })
  })

  /**
   * Dismiss a variance flag (E06-S06 acceptance 5).
   *
   * The reason is required by the schema here, by a CHECK constraint in the database, and is
   * written to the audit log. Three layers because a flag dismissed without explanation leaves
   * an appeal with nothing to answer.
   */
  app.post('/api/v1/scoring/cohorts/:cohortKey/variance/dismiss', { preHandler: requireRole('reviewer') }, async (req) => {
    const { cohortKey } = params(req, cohortParams)
    const input = body(req, dismissBody)
    return ok(await dismissFlag({
      cohortKey,
      submissionId: input.submissionId,
      actor: principalOf(req).email,
      reason: input.reason,
    }))
  })
}

/**
 * The measurements behind the engineering-quality score.
 *
 * Returns null rather than throwing when the scan is gone: the scores are still worth showing,
 * and a missing scan is a caption on one dimension, not a failure of the page.
 */
async function metricInputs(submissionId: number): Promise<
  { summary: string; metrics: unknown; filesAnalysed: number; filesTotal: number
    budgetTruncated: boolean; commitSha: string | null } | null
> {
  try {
    const scan = await persistedScan(submissionId)
    return {
      summary: describeMetrics(scan),
      metrics: scan.metrics,
      filesAnalysed: scan.filesAnalysed,
      filesTotal: scan.filesTotal,
      budgetTruncated: scan.budgetTruncated,
      commitSha: scan.commitSha,
    }
  } catch {
    return null
  }
}
