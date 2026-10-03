/**
 * Batch endpoints (E10).
 *
 * Starting a batch is an organiser act: it spends money and produces the scores a shortlist is
 * drawn from. Watching one is not, so progress is readable by any signed-in user.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { createLogger } from '../../../lib/logger.js'
import { errorMessage } from '../../../lib/appError.js'
import { withCorrelation, newCorrelationId } from '../../../lib/correlation.js'
import { runBatch } from '../services/batchOrchestrator.js'
import { batchProgress } from '../services/batchProgress.js'

const log = createLogger('batch', 'routes')
const runParams = z.object({ id: z.coerce.number().int().min(1) })

const startBody = z.object({
  challengeIds: z.array(z.number().int().min(1)).max(50).default([]),
  cohortKey: z.string().trim().min(1).max(200),
  runIndex: z.union([z.literal(1), z.literal(2)]),
  resumeRunId: z.number().int().min(1).optional(),
  force: z.boolean().default(false),
})

export async function registerBatchRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Start a cohort run.
   *
   * Returns as soon as the run is opened rather than holding the request for the hours the
   * batch takes. The run id comes back immediately so progress can be watched from the first
   * second; a request that waited would time out at a proxy long before the work finished, and
   * the operator would not know whether it was still going.
   */
  app.post('/api/v1/batch/runs', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const input = body(req, startBody)
    const actor = principalOf(req).email
    const correlationId = newCorrelationId()

    // The run is opened inside its own correlation scope, so every log line and ledger row for
    // the hours that follow traces back to this request. The promise below resolves as soon as
    // the run exists — not when it finishes.
    const opened = new Promise<Parameters<NonNullable<Parameters<typeof runBatch>[0]['onStarted']>>[0]>((resolve, reject) => {
      void withCorrelation({ correlationId }, async () => {
        try {
          const summary = await runBatch({
            challengeIds: input.challengeIds,
            cohortKey: input.cohortKey,
            runIndex: input.runIndex,
            startedBy: actor,
            force: input.force,
            onStarted: resolve,
            ...(input.resumeRunId !== undefined && { resumeRunId: input.resumeRunId }),
          })
          log.info('batch finished', {
            runId: summary.runId, status: summary.status,
            failures: summary.failures.length, costUsd: summary.costUsd,
          })
        } catch (err) {
          // A run that cannot START is the caller's problem and is reported here. One that fails
          // mid-flight has a ledger row, and is read from there.
          reject(err instanceof Error ? err : new Error(errorMessage(err)))
          log.error('batch could not start', { err })
        }
      })
    })

    const started = await opened

    return reply.code(202).send(ok({
      runId: started.runId,
      scoreRunId: started.scoreRunId,
      subjects: started.subjects,
      // Quoted up front so an operator can decide whether to start an overnight run, and null
      // rather than invented when nothing comparable has been measured.
      estimatedFinishAt: started.estimatedFinishAt,
      correlationId,
      message: 'The run has started. Watch its progress at /api/v1/batch/runs/{runId}/progress.',
    }))
  })

  /** Live-enough progress, readable after a reload (E10-S05 acceptance 2). */
  app.get('/api/v1/batch/runs/:id/progress', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, runParams)
    return ok(await batchProgress(id))
  })
}
