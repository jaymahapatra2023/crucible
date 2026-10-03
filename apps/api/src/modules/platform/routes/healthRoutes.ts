/**
 * Liveness, readiness and operational health (P9.4, P8.1).
 *
 * `/health` is unauthenticated and carries no data — it answers "is the process up".
 * `/ready` additionally checks the database, so an orchestrator does not route traffic to an
 * instance that cannot serve it.
 * `/api/v1/platform/health` is authenticated and describes *what is degraded*, which is
 * operational data and therefore not public.
 */
import type { FastifyInstance } from 'fastify'
import { ok } from '@crucible/contracts'
import { query } from '../../../db/pool.js'
import { requireRole } from '../../../http/auth.js'
import { appliedVersions } from '../../../db/migrationRunner.js'
import { listProviders } from '../../llm/providers/providerRegistry.js'
import { taskStatus } from '../jobs/scheduler.js'
import { isEnabled } from '../services/configService.js'
import { ceilingTrips } from '../../../http/rateLimit.js'
import { mail } from '../../../lib/ports/mailPort.js'
import { loadEnv } from '../../../config/env.js'

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ok({ status: 'ok' }))

  app.get('/ready', async (_req, reply) => {
    try {
      await query('SELECT 1')
      return ok({ status: 'ready' })
    } catch {
      reply.status(503)
      return { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Database is not reachable.' } }
    }
  })

  app.get('/api/v1/platform/health', { preHandler: requireRole('viewer') }, async () => {
    let reachable = true
    let migrations = 0
    try {
      migrations = (await appliedVersions()).length
    } catch {
      reachable = false
    }
    const providers = listProviders()
    const tasks = taskStatus()
    // A scheduled task that keeps failing is a degraded system even when everything else is up.
    const failingTask = tasks.some((t) => t.lastError !== null)
    const degraded = !reachable || providers.every((p) => !p.available) || failingTask
    // A tripped safety ceiling is not degradation — the system did its job — but it is a fact an
    // organiser must see (E41-S01 acceptance 7): something, somewhere, is looping.
    const ceilings = {
      enabled: await isEnabled('feature.http.rate_limit').catch(() => false),
      trips: ceilingTrips(),
    }
    // How teams are reached (E49-S03): which adapter, and whether Discord sits in front of it.
    const env = loadEnv()
    const delivery = {
      mail: mail().name,
      discord: env.DISCORD_BOT_TOKEN !== undefined
        ? ((await isEnabled('feature.notify.discord').catch(() => false)) ? 'live' : 'off')
        : 'unconfigured',
      guildId: env.DISCORD_GUILD_ID ?? null,
    }
    return ok({
      status: degraded ? 'DEGRADED' : 'HEALTHY',
      database: { reachable, migrations },
      providers,
      tasks,
      ceilings,
      delivery,
    })
  })
}
