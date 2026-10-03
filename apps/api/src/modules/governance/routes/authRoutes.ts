/**
 * Authentication endpoints. `/api/v1/auth/login` is on the P8.1 public allow-list — it is the
 * bootstrap of authentication itself and cannot require a token.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ok, pageMeta, paginationQuerySchema, toLimitOffset } from '@crucible/contracts'
import { body, query } from '../../../http/validate.js'
import { principalOf, requireRole, ROLES } from '../../../http/auth.js'
import { createUser, getUsers, signIn } from '../services/identityService.js'

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
})

const createUserBody = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200),
  password: z.string().min(12).max(512),
  role: z.enum(ROLES),
})

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/auth/login', async (req) => {
    const input = body(req, loginBody)
    return ok(await signIn(input.email, input.password))
  })

  app.get('/api/v1/auth/me', { preHandler: requireRole('viewer') }, async (req) =>
    ok(principalOf(req)),
  )

  app.get('/api/v1/governance/users', { preHandler: requireRole('admin') }, async (req) => {
    const q = query(req, paginationQuerySchema)
    const { limit, offset } = toLimitOffset(q)
    const { users, total } = await getUsers(limit, offset)
    return ok(users, pageMeta(total, q.page, q.pageSize))
  })

  app.post('/api/v1/governance/users', { preHandler: requireRole('admin') }, async (req, reply) => {
    const input = body(req, createUserBody)
    const created = await createUser({ ...input, actor: principalOf(req).email })
    reply.status(201)
    return ok(created)
  })
}
