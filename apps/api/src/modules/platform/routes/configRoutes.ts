/**
 * Runtime configuration and feature flags (P3.6, P7.5, P12.3).
 *
 * Reading is open to any authenticated staff member; writing requires `admin`, because these
 * values change what the scoring pipeline does.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import { principalOf, requireRole } from '../../../http/auth.js'
import {
  getJson, getNumber, getString, listConfig, listFlags, setConfig, setFlag,
} from '../services/configService.js'
import { recordAudit } from '../../../lib/ports/auditPort.js'

const listQuery = z.object({ module: z.string().min(1).max(50).optional() })
const keyParams = z.object({ key: z.string().min(1).max(200) })
const setBody = z.object({ value: z.unknown() })
const flagBody = z.object({ enabled: z.boolean() })

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The facts about this event, in one place (E19-S01).
   *
   * A VIEW over the configuration store, not a second home for the values — two homes for one
   * fact drift, and writes still go through the ordinary config endpoints so they stay audited
   * and historised like every other setting.
   */
  app.get('/api/v1/platform/event', { preHandler: requireRole('viewer') }, async () => {
    const [evaluationDate, window, dryRunLeadDays, registerUrl, submitUrl, discordInviteUrl] = await Promise.all([
      getString('event.evaluation_date'),
      getJson<{ startsAt?: string; endsAt?: string } | null>('scans.event_window'),
      getNumber('event.dry_run_lead_days'),
      getString('event.register_url'), getString('event.submit_url'), getString('event.discord_invite_url'),
    ])
    const orNull = (v: string) => (v.trim() === '' ? null : v.trim())
    return ok({
      evaluationDate: orNull(evaluationDate),
      window: window?.startsAt && window.endsAt
        ? { startsAt: window.startsAt, endsAt: window.endsAt }
        : null,
      dryRunLeadDays,
      // The public links (E50): what the emails carry and what the QR codes encode.
      registerUrl: orNull(registerUrl), submitUrl: orNull(submitUrl), discordInviteUrl: orNull(discordInviteUrl),
    })
  })

  app.get('/api/v1/platform/config', { preHandler: requireRole('viewer') }, async (req) => {
    const q = query(req, listQuery)
    return ok(await listConfig(q.module))
  })

  app.patch('/api/v1/platform/config/:key', { preHandler: requireRole('admin') }, async (req) => {
    const { key } = params(req, keyParams)
    const { value } = body(req, setBody)
    const actor = principalOf(req).email
    const row = await setConfig(key, value, actor)
    await recordAudit({
      actor, action: 'config.updated', subjectType: 'app_config', subjectId: key,
      payload: { value },
    })
    return ok(row)
  })

  app.get('/api/v1/platform/flags', { preHandler: requireRole('viewer') }, async () =>
    ok(await listFlags()),
  )

  app.patch('/api/v1/platform/flags/:key', { preHandler: requireRole('admin') }, async (req) => {
    const { key } = params(req, keyParams)
    const { enabled } = body(req, flagBody)
    const actor = principalOf(req).email
    const row = await setFlag(key, enabled, actor)
    await recordAudit({
      actor, action: 'feature_flag.updated', subjectType: 'feature_flag', subjectId: key,
      payload: { enabled },
    })
    return ok(row)
  })
}
