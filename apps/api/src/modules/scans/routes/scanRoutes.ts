/**
 * Scan endpoints (E04).
 *
 * Scanning is an explicit action. There is deliberately no endpoint that scans as a side effect
 * of something else: E04-S05 acceptance 2 requires scoring to read persisted output, and a scan
 * that could be triggered implicitly would make cost and the evaluated commit unpredictable.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, pageMeta, paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import { SCAN_DEPTHS } from '@crucible/scanner'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { AppError } from '../../../lib/appError.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'
import { scanSubmission, persistedScan } from '../services/scanService.js'
import {
  countScans, listScans, resolveProvenance, selectCoverage, selectFlaggedProvenance,
  selectLatestScan,
  selectProvenance, selectScan,
} from '../db/scanDb.js'

const idParams = z.object({ id: z.coerce.number().int().min(1) })

/**
 * What a person concluded. Ten characters minimum, matching the table's own constraint.
 *
 * "Looked at it" is not a conclusion, and a conclusion nobody can read is the same as none.
 */
const resolveBody = z.object({
  reason: z.string().trim().min(10).max(2000),
})

const scanBody = z.object({
  depth: z.enum(SCAN_DEPTHS).optional(),
  force: z.boolean().default(false),
})

export async function registerScanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/scans', { preHandler: requireRole('viewer') }, async (req) => {
    const q = query(req, paginationQuerySchema)
    const { limit, offset } = toLimitOffset(q)
    const [scans, total] = await Promise.all([listScans(limit, offset), countScans()])
    return ok(scans, pageMeta(total, q.page, q.pageSize))
  })

  /** Coverage across all submissions — what E08-S06 uses to label truncated scans. */
  app.get('/api/v1/scans/coverage', { preHandler: requireRole('viewer') }, async () =>
    ok(await selectCoverage()),
  )

  /** Provenance flags awaiting human review. Flags, never exclusions (E04-S06 #2). */
  app.get('/api/v1/scans/provenance/flagged', { preHandler: requireRole('viewer') }, async () =>
    ok(await selectFlaggedProvenance()),
  )

  /**
   * Record what a person concluded about a flagged history (E19-S03).
   *
   * Records a conclusion and nothing more. There is deliberately no endpoint that excludes a
   * submission on provenance grounds — E04-S06 is explicit that these are flags.
   */
  app.post('/api/v1/scans/provenance/:id/resolve', { preHandler: requireRole('organiser') },
    async (req) => {
      const { id } = params(req, idParams)
      const { reason } = body(req, resolveBody)
      const actor = principalOf(req).email

      await resolveProvenance({ submissionId: id, reason, actor })
      await recordAudit({
        actor, action: 'scans.provenance_resolved',
        subjectType: 'submission', subjectId: String(id), payload: { reason },
      })
      return ok({ submissionId: id, resolved: true })
    })

  app.get('/api/v1/scans/:id', { preHandler: requireRole('viewer') }, async (req) => {
    const scan = await selectScan(params(req, idParams).id)
    if (!scan) throw new AppError('NOT_FOUND', `Scan ${params(req, idParams).id} was not found.`)
    return ok(scan)
  })

  app.post('/api/v1/submissions/:id/scan', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const { id } = params(req, idParams)
    const input = req.body ? body(req, scanBody) : { force: false }
    const outcome = await scanSubmission({
      submissionId: id,
      ...(input.depth !== undefined && { depth: input.depth }),
      force: input.force,
      actor: principalOf(req).email,
    })
    reply.status(outcome.skipped ? 200 : 201)
    return ok(outcome)
  })

  app.get('/api/v1/submissions/:id/scan', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    const scan = await selectLatestScan(id)
    if (!scan) {
      throw new AppError('NOT_FOUND', `Submission ${id} has not been scanned yet.`)
    }
    return ok(scan)
  })

  /** The scanner's stored output, including file contents — what scoring reads. */
  app.get('/api/v1/submissions/:id/scan/result', { preHandler: requireRole('reviewer') }, async (req) =>
    ok(await persistedScan(params(req, idParams).id)),
  )

  app.get('/api/v1/submissions/:id/provenance', { preHandler: requireRole('viewer') }, async (req) => {
    const { id } = params(req, idParams)
    const provenance = await selectProvenance(id)
    if (!provenance) {
      // Absent provenance is a real, meaningful state — not an error and not zeroes.
      return ok(null, { reason: 'No readable git history, or provenance analysis is disabled.' })
    }
    return ok(provenance)
  })
}
