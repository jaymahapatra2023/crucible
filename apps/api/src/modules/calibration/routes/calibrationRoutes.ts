/**
 * Calibration and gate endpoints (E11).
 *
 * Everything that changes the calibration record is organiser-and-above: the golden set, the
 * criteria and the decision are the evidence that this system was shown fit to eliminate teams.
 * Reading is open to any signed-in user, because a reviewer is entitled to know whether the
 * scores they are looking at came from a calibrated system.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import {
  addEntry, createGoldenSet, entriesFor, listSets, rankingsFor, readiness,
  recordRanking, requireSet, seal,
} from '../services/goldenSetService.js'
import { generateReport } from '../services/calibrationReport.js'
import { linkGoldenSet } from '../services/goldenSetLink.js'
import { assess, decide, gateStatus, recordCriteria } from '../services/gateService.js'
import { dryRunReport } from '../services/dryRunReport.js'
import { currentCriteria, criteriaHistory, selectReport } from '../db/gateDb.js'

const setParams = z.object({ id: z.coerce.number().int().min(1) })
const reportParams = z.object({ id: z.coerce.number().int().min(1) })

const entryBody = z.object({
  label: z.string().trim().min(1).max(200),
  repoUrl: z.string().trim().url().max(500),
  expectedBand: z.enum(['STRONG', 'MIDDLING', 'WEAK']),
  edgeCase: z.enum(['SCAFFOLD_ONLY', 'WRONG_PROBLEM', 'FAILS_TO_BUILD', 'VERY_LARGE']).nullable()
    .default(null),
  notes: z.string().trim().max(2000).default(''),
})

const rankingBody = z.object({
  ranker: z.string().trim().min(1).max(200),
  positions: z.array(z.object({
    entryId: z.number().int().min(1),
    position: z.number().int().min(1),
    rationale: z.string().trim().max(2000).optional(),
  })).min(1).max(200),
})

const criteriaBody = z.object({
  minRankCorrelation: z.number().min(-1).max(1),
  maxMaterialDisagreements: z.number().int().min(0).max(100),
  materialRankGap: z.number().int().min(1).max(100),
  maxRunVariance: z.number().min(0).max(100),
  // Twenty characters, matching the CHECK, so the caller gets a useful 400 rather than a
  // constraint violation translated after the fact.
  fallbackPlan: z.string().trim().min(20).max(4000),
  notes: z.string().trim().max(4000).default(''),
})

const decisionBody = z.object({
  decision: z.enum(['GO', 'NO_GO']),
  rationale: z.string().trim().min(20).max(4000),
})

export async function registerCalibrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/calibration/sets', { preHandler: requireRole('viewer') }, async () =>
    ok(await listSets()),
  )

  app.post('/api/v1/calibration/sets', { preHandler: requireRole('organiser') }, async (req) => {
    const input = body(req, z.object({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).default(''),
    }))
    return ok(await createGoldenSet({ ...input, actor: principalOf(req).email }))
  })

  app.get('/api/v1/calibration/sets/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, setParams)
    const [set, entries, state] = await Promise.all([
      requireSet(id), entriesFor(id), readiness(id),
    ])
    return ok({ set, entries, readiness: state })
  })

  app.post('/api/v1/calibration/sets/:id/entries', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, setParams)
    const input = body(req, entryBody)
    return ok(await addEntry({ goldenSetId: id, ...input, actor: principalOf(req).email }))
  })

  /**
   * One person's hand ranking.
   *
   * Reviewer and above: hand-ranking is a judging act, and E11-S01 wants at least two people
   * doing it independently rather than one organiser doing it twice.
   */
  app.post('/api/v1/calibration/sets/:id/rankings', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, setParams)
    const input = body(req, rankingBody)
    await recordRanking({
      goldenSetId: id, ranker: input.ranker, positions: input.positions,
      actor: principalOf(req).email,
    })
    return ok({ recorded: input.positions.length })
  })

  /**
   * Hand rankings.
   *
   * While the set is OPEN a caller sees only their own — independence cannot be restored once
   * one ranker has seen another's ordering.
   */
  app.get('/api/v1/calibration/sets/:id/rankings', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, setParams)
    const q = query(req, z.object({ ranker: z.string().trim().max(200).optional() }))
    const set = await requireSet(id)
    return ok({
      sealed: set.status === 'SEALED',
      rankings: await rankingsFor(id, q.ranker ?? principalOf(req).email),
    })
  })

  app.post('/api/v1/calibration/sets/:id/seal', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, setParams)
    return ok(await seal(id, principalOf(req).email))
  })

  /**
   * Connect each ranked repository to the submission the machine scored (E21).
   *
   * Without this the report has a human ordering and nothing to compare it against, and refuses.
   * `confirm: false` returns the matching and writes nothing; `confirm: true` records it, and
   * refuses outright if any entry is unresolved.
   */
  app.post('/api/v1/calibration/sets/:id/link', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, setParams)
    const input = body(req, z.object({ confirm: z.boolean().default(false) }))
    return ok(await linkGoldenSet({
      goldenSetId: id, confirm: input.confirm, actor: principalOf(req).email,
    }))
  })

  /** Gate criteria — recorded BEFORE any report can be produced (E11-S03 acceptance 1). */
  app.post('/api/v1/calibration/sets/:id/criteria', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, setParams)
    const input = body(req, criteriaBody)
    return ok(await recordCriteria({
      goldenSetId: id, ...input, actor: principalOf(req).email,
    }))
  })

  app.get('/api/v1/calibration/sets/:id/criteria', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, setParams)
    return ok({ current: await currentCriteria(id), history: await criteriaHistory(id) })
  })

  app.post('/api/v1/calibration/sets/:id/report', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, setParams)
    const input = body(req, z.object({
      runIndexId: z.number().int().min(1),
      cohortKey: z.string().trim().max(200).optional(),
    }))
    return ok(await generateReport({
      goldenSetId: id,
      runIndexId: input.runIndexId,
      ...(input.cohortKey !== undefined && { cohortKey: input.cohortKey }),
      actor: principalOf(req).email,
    }))
  })

  /** A report with what the recorded criteria say about it — a suggestion, not a decision. */
  app.get('/api/v1/calibration/reports/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, reportParams)
    const report = await selectReport(id)
    if (!report) throw new AppError('NOT_FOUND', `Calibration report ${id} was not found.`)

    const criteria = await currentCriteria(report.golden_set_id)
    return ok({
      report,
      criteria,
      assessment: criteria ? assess(report, criteria) : null,
    })
  })

  app.post('/api/v1/calibration/reports/:id/decision', { preHandler: requireRole('organiser') }, async (req) => {
    const { id } = params(req, reportParams)
    const input = body(req, decisionBody)
    return ok(await decide({
      reportId: id, decision: input.decision, rationale: input.rationale,
      actor: principalOf(req).email,
    }))
  })

  /**
   * What a full-scale rehearsal measured (E11-S04).
   *
   * Readable by any signed-in user: it describes the machine, not anyone's work.
   */
  app.get('/api/v1/calibration/dry-run/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, reportParams)
    return ok(await dryRunReport(id))
  })

  /** Whether this system is currently permitted to rank, and on whose decision. */
  app.get('/api/v1/calibration/gate', { preHandler: requireRole('viewer') }, async () => {
    const status = await gateStatus()
    return ok({
      status,
      rankingPermitted: status?.decision === 'GO',
      // Spelled out, because "no decision" is the state most easily mistaken for a pass.
      note: status === null
        ? 'No go/no-go decision has been recorded. Ranking is refused until one is: an '
          + 'uncalibrated system must not be usable by default.'
        : null,
    })
  })
}
