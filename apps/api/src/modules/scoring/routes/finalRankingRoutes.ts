/**
 * The final ranking of a cohort (E50): both runs combined, one list.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { params } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import { computeFinalRanking, finalRankingCsv, getFinalRanking } from '../services/finalRankingService.js'

const cohortParams = z.object({ cohortKey: z.string().min(1).max(200) })

export async function registerFinalRankingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/scoring/cohorts/:cohortKey/final', { preHandler: requireRole('organiser') }, async (req) =>
    ok(await computeFinalRanking(params(req, cohortParams).cohortKey, principalOf(req).email)),
  )

  app.get('/api/v1/scoring/cohorts/:cohortKey/final', { preHandler: requireRole('reviewer') }, async (req) =>
    ok(await getFinalRanking(params(req, cohortParams).cohortKey)),
  )

  app.get('/api/v1/scoring/cohorts/:cohortKey/final.csv', { preHandler: requireRole('reviewer') }, async (req, reply) => {
    const { cohortKey } = params(req, cohortParams)
    reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="crucible-final-ranking-${cohortKey}.csv"`)
    return finalRankingCsv(cohortKey)
  })
}
