/**
 * The public registration surface (E44, P8.1).
 *
 * Four routes, all on the allow-list, and not one of them returns a list of participants or
 * teams. The link is verified at its mount point — the same factor-at-mount-point arrangement
 * as a submission token — so every scoped route names nothing that could reach another
 * registrant's link.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok } from '@crucible/contracts'
import { body, params, query } from '../../../http/validate.js'
import {
  checkTeamName, confirmRegistration, lookupTeammate, startRegistration, verifyLink,
  checkDiscordUsername,
} from '../services/registrationService.js'

const email = z.string().trim().email().max(320)
const linkParams = z.object({ token: z.string().min(8).max(200) })

export async function registerRegistrationRoutes(app: FastifyInstance): Promise<void> {
  /** One email in, one sentence out. Nothing about the roster in the response (E44-S01). */
  app.post('/api/v1/register/start', async (req) =>
    ok(await startRegistration(body(req, z.object({ email })))),
  )

  /**
   * What the link resolves to: the registrant's OWN name, the open challenges, the size bounds.
   * Never another participant (E44-S02 acceptance 1).
   */
  app.get('/api/v1/register/:token', async (req) => {
    const scope = await verifyLink(params(req, linkParams).token)
    return ok({
      registrantName: scope.registrantName,
      bounds: scope.bounds,
      expiresAt: scope.expiresAt,
      // Whether a Discord username can be checked and used (E49). A flag and an invite, nothing
      // about anybody.
      discord: scope.discord,
    })
  })

  /** Is this name free? Checked live, by the owning module's normalisation. */
  app.get('/api/v1/register/:token/name', async (req) => {
    await verifyLink(params(req, linkParams).token)
    const q = query(req, z.object({ name: z.string().max(200).default('') }))
    return ok(await checkTeamName(q.name))
  })

  /** One teammate by EXACT address. One name or "not on the roster"; never a search. */
  app.post('/api/v1/register/:token/lookup', async (req) => {
    const scope = await verifyLink(params(req, linkParams).token)
    return ok(await lookupTeammate(scope, body(req, z.object({ email })).email))
  })

  /** One Discord username in, one name or a reason out (E49-S02). Never a list. */
  app.post('/api/v1/register/:token/discord', async (req) => {
    const scope = await verifyLink(params(req, linkParams).token)
    const input = body(req, z.object({ username: z.string().trim().min(1).max(64) }))
    return ok(await checkDiscordUsername(scope, input.username))
  })

  /** Everything, or nothing. Confirms the token was SENT, never returns it (acceptance 4). */
  app.post('/api/v1/register/:token/confirm', async (req, reply) => {
    const scope = await verifyLink(params(req, linkParams).token)
    const input = body(req, z.object({
      displayName: z.string().trim().min(2).max(200),
      teammateIds: z.array(z.number().int().min(1)).max(20).default([]),
      discordUsername: z.string().trim().max(64).nullable().optional(),
      /**
       * A Discord username per teammate who gave one (migration 100). Ids not on this team are
       * discarded by the service, so a crafted body cannot rewrite a stranger's contact details.
       */
      teammateDiscord: z.array(z.object({
        participantId: z.number().int().min(1),
        username: z.string().trim().max(64),
      })).max(20).default([]),
    }))
    const outcome = await confirmRegistration({ scope, ...input })
    reply.status(201)
    return ok(outcome)
  })
}
