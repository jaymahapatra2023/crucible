/**
 * Coach sheets (E51): one per shortlisted team, readable by reviewers, sent by organisers.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { coachSheet, coachSheets, dispatchState, sendCoachSheets } from '../services/coachSheet.js'
import { renderSheetText } from '../services/coachSheetRender.js'

const runParams = z.object({ id: z.coerce.number().int().min(1) })
const teamParams = runParams.extend({ submissionId: z.coerce.number().int().min(1) })
const scopeQuery = z.object({ scope: z.enum(['shortlist', 'cutline']).default('shortlist') })

export async function registerCoachRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/review/runs/:id/coach-sheets', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id } = params(req, runParams)
    const { scope } = query(req, scopeQuery)
    const [sheets, dispatches] = await Promise.all([coachSheets(id, scope), dispatchState(id)])
    return ok({ scope, sheets, dispatches })
  })

  app.get('/api/v1/review/runs/:id/teams/:submissionId/coach-sheet', { preHandler: requireRole('reviewer') }, async (req) => {
    const { id, submissionId } = params(req, teamParams)
    return ok(await coachSheet(id, submissionId))
  })

  /** The whole set as one printable text file, with standing — the organiser's copy. */
  app.get('/api/v1/review/runs/:id/coach-sheets.txt', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const { id } = params(req, runParams)
    const { scope } = query(req, scopeQuery)
    const sheets = await coachSheets(id, scope)
    reply.type('text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="crucible-coach-sheets-run-${id}.txt"`)
    return sheets.map((s) => renderSheetText(s, { forCoach: false })).join('\n\n' + '='.repeat(72) + '\n\n')
  })

  app.post('/api/v1/review/runs/:id/coach-sheets/send', { preHandler: requireRole('organiser') }, async (req, reply) => {
    const { id } = params(req, runParams)
    const { scope } = query(req, scopeQuery)
    reply.status(201)
    return ok(await sendCoachSheets({ runIndexId: id, scope, actor: principalOf(req).email }))
  })
}
